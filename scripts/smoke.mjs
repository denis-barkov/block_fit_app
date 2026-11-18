import {readFileSync,statSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {planning} from '../config/settings.ts';

export async function smoke(env) {
  const filename='.blockfit/prod-smoke.env';
  if(statSync(filename).mode&0o077)throw new Error('Protect .blockfit/prod-smoke.env with mode 0600.');
  const credentials=parseEnv(readFileSync(filename,'utf8'));
  for(const role of ['resident','staff']) {
    const prefix=role.toUpperCase();
    const email=credentials[prefix+'_EMAIL'];
    const password=credentials[prefix+'_PASSWORD'];
    if(!email||!password)throw new Error('Configure both dedicated smoke accounts in .blockfit/prod-smoke.env.');
    let cookie='';
    async function http(path,method='GET',data) {
      return fetch(env.APP_ORIGIN+'/api'+path,{method,headers:{Origin:env.APP_ORIGIN,
        ...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},
      body:data?JSON.stringify(data):undefined,redirect:'error',signal:AbortSignal.timeout(30_000)});
    }
    const signIn=await http('/auth/sign-in/email','POST',{email,password});
    if(!signIn.ok)throw new Error(`Smoke login failed for the dedicated ${role} account (${signIn.status}).`);
    cookie=signIn.headers.getSetCookie().map(entry=>entry.split(';',1)[0]).join('; ');
    try {
      const session=await (await http('/me')).json();
      if(session.user?.role!==role)throw new Error(`Smoke account role mismatch for ${role}.`);
      if(!(await http('/inventory')).ok)throw new Error('Public inventory check failed.');
      if(role==='resident') {
        if((await http('/staff/inventory')).status!==403 || !(await http('/resident')).ok)throw new Error('Resident access check failed.');
      } else {
        const result=await http('/staff/compare','POST',{category:'pull-up',radius:planning.radius,horizon:planning.horizon,
          budget:planning.budget,selected:[]});
        if(!result.ok)throw new Error(`Staff comparison check failed (${result.status}).`);
      }
    } finally {
      if(!(await http('/auth/sign-out','POST',{})).ok)throw new Error('Smoke session logout failed.');
    }
  }
  console.log('Production smoke passed for both dedicated roles.');
}
