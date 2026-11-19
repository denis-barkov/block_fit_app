import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {z} from 'zod';
import {state} from './environment.mjs';
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
  return new Promise((resolve,reject)=>{
    let value='';
    function close() {
      stdin.off('data',read);
      stdin.off('end',end);
      stdin.off('error',fail);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    }
    function fail(error) {close();reject(error);}
    function end() {fail(new Error('Password input ended unexpectedly.'));}
    function read(buffer) {
      for(const char of buffer.toString()) {
        if(char==='\r'||char==='\n') {close();resolve(value);return;}
        if(char==='\x03'||char==='\x04') {fail(new Error('Account maintenance cancelled.'));return;}
        if(char==='\x7f'||char==='\b') value=Array.from(value).slice(0,-1).join('');
        else if(char>=' ' && value.length<=limits.maxPassword) value+=char;
      }
    }
    stdin.setRawMode(true);
    stdin.on('data',read);
    stdin.once('end',end);
    stdin.once('error',fail);
    stdin.resume();
  });
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


const accountDefinitions=z.array(z.object({
  email:z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name:z.string().trim().min(1).max(limits.shortText),
  role:z.enum(['resident','staff']),
  purpose:z.enum(['presentation','automated-test']),
}).strict()).min(1).max(50);
export function validateDefinitions(input) {
  const parsed=accountDefinitions.safeParse(input);
  if(!parsed.success)throw new Error('Invalid account definition. Check email, name, role and purpose. Password fields are forbidden.');
  const definitions=parsed.data;
  if(new Set(definitions.map(entry=>entry.email)).size!==definitions.length)throw new Error('Duplicate login in the account definitions.');
  for(const role of ['resident','staff']) {
    if(definitions.filter(entry=>entry.purpose==='automated-test'&&entry.role===role).length>1) {
      throw new Error(`Define at most one automated-test ${role} per target.`);
    }
  }
  return definitions;
}

export async function accountPlan(db,definitions) {
  return Promise.all(definitions.map(async entry=>{
    const user=await db.prepare('SELECT id,name,role,purpose FROM user WHERE email=?').bind(entry.email).first();
    const action=!user?'create':user.role!==entry.role||user.purpose!==entry.purpose?'conflict':
      user.name!==entry.name?'update display name':'keep';
    return {...entry,id:user?.id,action};
  }));
}

export async function applyAccountPlan(db,env,plan,getPassword) {
  if(plan.some(entry=>entry.action==='conflict')) throw new Error('Resolve existing login conflicts explicitly before provisioning.');
  const auth=createAuth({DB:db,...env});
  const passwords=new Map();
  for(const entry of plan.filter(entry=>entry.action==='create')) {
    const password=await getPassword(entry);
    if(typeof password!=='string'||password.length<limits.minPassword||password.length>limits.maxPassword) {
      throw new Error(`The new ${entry.role} password does not meet length limits.`);
    }
    passwords.set(entry.email,password);
  }
  for(const entry of plan) {
    if(entry.action==='create') {
      await createOperatorAccount(db,env,{...entry,password:passwords.get(entry.email)});
    } else if(entry.action==='update display name') {
      const {internalAdapter}=await auth.$context;
      await internalAdapter.updateUser(entry.id,{name:entry.name});
    }
  }
}

export function smokeCredentials(env,role) {
  const path=resolve(state,`${env.DEPLOYMENT}-smoke.env`);
  if(statSync(path).mode&0o077)throw new Error(`Protect ${env.DEPLOYMENT}-smoke.env with mode 0600.`);
  const values=parseEnv(readFileSync(path,'utf8'));
  const prefix=role.toUpperCase();
  const email=values[prefix+'_EMAIL']?.trim().toLowerCase();
  const password=values[prefix+'_PASSWORD'];
  if(!email||!password)throw new Error(`Configure the dedicated ${role} login in ${env.DEPLOYMENT}-smoke.env.`);
  return {email,password};
}

export async function provisionAccounts(db,env,[file,apply]) {
  const path=resolve(file||resolve(state,`${env.DEPLOYMENT}-accounts.json`));
  if(!path.startsWith(state+'/'))throw new Error('Keep operator account definitions under the ignored .blockfit directory.');
  let input;
  try {input=JSON.parse(readFileSync(path,'utf8'));}
  catch {throw new Error('Copy config/accounts.example.json to the ignored target account file and fill in the named logins.');}
  const plan=await accountPlan(db,validateDefinitions(input));
  for(const entry of plan) console.log(`  ${entry.action}: ${entry.email} (${entry.role}, ${entry.purpose})`);
  if(plan.some(entry=>entry.action==='conflict'))throw new Error('Resolve existing login conflicts explicitly before provisioning. Existing accounts are unchanged.');
  if(apply!=='yes') {console.log('Preview only. Use APPLY=yes after reviewing the plan.');return;}
  if(env.DEPLOYMENT==='prod' && await prompt(`Type ${env.resourceName} to apply this account plan: `)!==env.resourceName) {
    throw new Error('Account provisioning cancelled.');
  }
  await applyAccountPlan(db,env,plan,async entry=>{
    if(entry.purpose==='automated-test') {
      const {email,password}=smokeCredentials(env,entry.role);
      if(email!==entry.email)throw new Error(`The protected test login does not match the ${entry.role} definition.`);
      return password;
    }
    const password=await passwordOnce(`Password for ${entry.email}: `);
    if(password!==await passwordOnce('Confirm password: '))throw new Error('Passwords must match.');
    return password;
  });
  console.log('Account plan applied. Existing passwords and roles were preserved.');
}
