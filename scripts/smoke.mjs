import {randomUUID} from 'node:crypto';
import {smokeCredentials} from './accounts.mjs';
import {categories,pilot,planning} from '../config/settings.ts';

export async function smoke(env,db,{transport=fetch,readCredentials=smokeCredentials}={}) {
  const secure=env.APP_ORIGIN.startsWith('https:');
  if (secure) {
    const staff=await transport(env.APP_ORIGIN+'/staff',{redirect:'manual',signal:AbortSignal.timeout(30_000)});
    const location=staff.headers.get('Location');
    const redirect=location&&URL.parse(location,env.APP_ORIGIN);
    if(staff.status!==302 || redirect?.origin!==env.APP_ORIGIN || redirect.pathname!=='/staff/login') {
      throw new Error('Anonymous staff access must redirect to the canonical Pages origin.');
    }
  }
  const marker='smoke-'+randomUUID();
  let owner;
  let category;
  async function run(role,action) {
    const {email,password}=readCredentials(env,role);
    let cookie='';
    const http=(path,method='GET',data)=>transport(env.APP_ORIGIN+'/api'+path,{method,headers:{
      Origin:env.APP_ORIGIN,...cookie&&{Cookie:cookie},...data&&{'Content-Type':'application/json'},
    },body:data?JSON.stringify(data):undefined,redirect:'error',signal:AbortSignal.timeout(30_000)});
    const signIn=await http('/auth/sign-in/email','POST',{email,password});
    if(!signIn.ok)throw new Error(`Smoke login failed for dedicated ${role} (${signIn.status}).`);
    const cookies=signIn.headers.getSetCookie();
    cookie=cookies.map(entry=>entry.split(';',1)[0]).join('; ');
    try {
      if(secure && (!cookies.some(entry=>/;\s*Secure(?:;|$)/i.test(entry)&&/;\s*HttpOnly(?:;|$)/i.test(entry)) ||
          cookies.some(entry=>/;\s*Domain=/i.test(entry)||entry.includes('workers.dev')))) {
        throw new Error('Production login must issue a secure, host-only session cookie.');
      }
      const session=await (await http('/me')).json();
      if(session.user?.role!==role||session.user?.purpose!=='automated-test') {
        throw new Error(`Smoke requires a dedicated automated-test ${role} account.`);
      }
      if(!(await http('/inventory')).ok)throw new Error('Public inventory check failed.');
      await action(http,session.user);
    } finally {
      if(!(await http('/auth/sign-out','POST',{})).ok)throw new Error('Smoke session logout failed.');
    }
  }
  try {
    await run('resident',async(http,user)=>{
      if((await http('/staff/inventory')).status!==403)throw new Error('Resident staff access check failed.');
      const result=await http('/resident');
      if(!result.ok)throw new Error('Resident smoke data could not be loaded.');
      const {location,requests}=await result.json();
      const active=new Set(requests.filter(row=>row.status==='recorded').map(row=>row.category));
      category=Object.keys(categories).find(key=>!active.has(key));
      if(!category)throw new Error('No free equipment category on the dedicated smoke resident account.');
      owner=user.id;
      if(!location && !(await http('/resident/location','PUT',{...pilot.center,label:marker,confirmed:true})).ok) {
        throw new Error('Could not save the smoke location.');
      }
      if(!(await http('/resident/requests','POST',{category,note:marker,suggestion:'',point:null})).ok) {
        throw new Error('Could not record the isolated smoke request.');
      }
    });
    await run('staff',async http=>{
      const scenario={category,radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
      const response=await http('/staff/compare','POST',scenario);
      if(!response.ok)throw new Error(`Staff comparison check failed (${response.status}).`);
      const result=await response.json();
      if(!result.testWorkspace||result.demandCount<1||result.origins.some(origin=>origin.synthetic)) {
        throw new Error('The automated smoke comparison must contain only isolated test demand.');
      }
      if((await http('/staff/inventory')).status!==403)throw new Error('Test staff can access shared inventory.');
    });
  } finally {
    if(owner) await db.batch([
      db.prepare("DELETE FROM demand WHERE owner=? AND note=? AND EXISTS(SELECT 1 FROM user WHERE id=? AND purpose='automated-test')")
        .bind(owner,marker,owner),
      db.prepare("DELETE FROM locations WHERE owner=? AND label=? AND EXISTS(SELECT 1 FROM user WHERE id=? AND purpose='automated-test')")
        .bind(owner,marker,owner),
    ]);
  }
  console.log('Smoke passed for both dedicated roles. Scoped sample data was cleaned up.');
}
