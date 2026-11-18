import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {createAuth} from '../src/server/auth.ts';
import {limits} from '../config/settings.ts';
import {createOperatorAccount} from './fixtures.mjs';

async function prompt(label) {
  const terminal=createInterface({input:stdin,output:stdout});
  try {return (await terminal.question(label)).trim();}
  finally {terminal.close();}
}
async function passwordOnce(label) {
  if(!stdin.isTTY) throw new Error('Account maintenance requires an interactive terminal.');
  stdout.write(label);
  stdin.setRawMode(true);stdin.resume();
  try {
    let value='';
    for await(const buffer of stdin.iterator({destroyOnReturn:false})) {
      for(const char of buffer.toString()) {
        if(char==='\r'||char==='\n') return value;
        if(char==='\x03'||char==='\x04') throw new Error('Account maintenance cancelled.');
        if(char==='\x7f'||char==='\b') value=Array.from(value).slice(0,-1).join('');
        else if(char>=' ' && value.length<=limits.maxPassword) value+=char;
      }
    }
    throw new Error('Password input ended unexpectedly.');
  } finally {stdin.setRawMode(false);stdin.pause();stdout.write('\n');}
}
export async function setPassword(db,env,owner,password) {
  const auth=createAuth({DB:db,...env});
  const {password:passwordModule}=await auth.$context;
  if(password.length<limits.minPassword || password.length>limits.maxPassword) throw new Error('Invalid password length.');
  const hash=await passwordModule.hash(password);
  const credential=await db.prepare("SELECT id FROM account WHERE userId=? AND providerId='credential'").bind(owner).first();
  if(!credential)throw new Error('The account has no password credential.');
  // Update the library-managed credential and revoke all sessions in one D1 transaction.
  await db.batch([
    db.prepare("UPDATE account SET password=?,updatedAt=? WHERE id=? AND userId=? AND providerId='credential'")
      .bind(hash,new Date().toISOString(),credential.id,owner),
    db.prepare('DELETE FROM session WHERE userId=?').bind(owner),
  ]);
}
export async function maintainAccount(command,db,env) {
  if(!stdin.isTTY) throw new Error('Account maintenance requires an interactive terminal.');
  const email=(await prompt('Account login email: ')).toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email) || email.length>254) throw new Error('Enter a valid account login.');
  const user=await db.prepare('SELECT id FROM user WHERE email=?').bind(email).first();
  if(command==='staff-create'&&user) throw new Error('This login already exists.');
  if(command!=='staff-create'&&!user) throw new Error('No account has that login.');
  if(command==='session-revoke') {
    const auth=createAuth({DB:db,...env});
    const {internalAdapter}=await auth.$context;
    await internalAdapter.deleteSessions(user.id);
    console.log('Sessions revoked.');return;
  }
  if(command==='password-reset' && await prompt('After independently verifying ownership, type VERIFIED: ')!=='VERIFIED') {
    throw new Error('Ownership confirmation is required.');
  }
  const name=command==='staff-create'?await prompt('Staff display name: '):'';
  const password=await passwordOnce(`Password (${limits.minPassword}–${limits.maxPassword} characters): `);
  const confirmation=await passwordOnce('Confirm password: ');
  if(password!==confirmation || password.length<limits.minPassword || password.length>limits.maxPassword) {
    throw new Error('Passwords must match and meet the length limits.');
  }
  if(command==='staff-create') {
    if(!name||name.length>limits.shortText)throw new Error('Enter a valid display name.');
    await createOperatorAccount(db,env,{email,password,name,role:'staff'});
    console.log('Staff account created.');
  } else {
    await setPassword(db,env,user.id,password);
    console.log('Password reset and existing sessions revoked.');
  }
}
