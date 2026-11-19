import {randomUUID} from 'node:crypto';
import {smokeCredentials} from './accounts.mjs';
import {pilot,planning} from '../config/settings.ts';
import {brandAssets} from '../config/app.ts';

export async function checkPublicDeployment(env,alias,{transport=fetch}={}) {
  const origin=env.APP_ORIGIN;
  const request=(url,init)=>transport(url,{redirect:'manual',signal:AbortSignal.timeout(30_000),...init});
  const navigation={headers:{Accept:'text/html'}};
  const privateValues=[env.resourceName+'.',env.CLOUDFLARE_ACCOUNT_ID,env.databaseId,
    env.AUTH_SECRET,env.OPENAI_API_KEY,env.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_TAG_API_TOKEN].filter(Boolean);
  async function inspect(response) {
    const visible=[...(response.headers.entries())].flat().join('\n')+'\n'+await response.text();
    if(privateValues.some(value=>visible.includes(value)))throw new Error('Private deployment details appeared in a public response.');
    return visible;
  }
  const home=await request(origin+'/',navigation);
  if(!home.ok||!home.headers.get('content-type')?.includes('text/html'))throw new Error('The public Pages shell is unavailable.');
  const html=await inspect(home);
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match=>match[1]);
  if(!assets.length)throw new Error('The public shell does not reference the expected frontend assets.');
  for(const path of [...assets,brandAssets.mark]) {
    const asset=await request(origin+path);
    if(!asset.ok||asset.headers.get('content-type')?.includes('text/html')||asset.headers.get('x-content-type-options')!=='nosniff') {
      throw new Error('A static Pages asset or its response headers could not be verified.');
    }
    await inspect(asset);
  }
  const checks=[
    ['/api/health',200],['/api/staff/goals',401],['/api/resident',401],
    ['/api/nonexistent-release-check',404],
  ];
  for(const [path,status] of checks) {
    const response=await request(origin+path,navigation);
    if(response.status!==status || !response.headers.get('content-type')?.includes('application/json') ||
      response.headers.get('cache-control')!=='no-store')throw new Error(`Unexpected public response at ${path}.`);
    await inspect(response);
  }
  const forbidden=await request(origin+'/api/auth/sign-out',{method:'POST',headers:{Origin:'https://example.invalid'}});
  if(forbidden.status!==403)throw new Error('Production accepted an untrusted mutation origin.');
  await inspect(forbidden);
  const missing=await request(origin+'/nonexistent-release-check',navigation);
  if(missing.status!==404||!missing.headers.get('content-type')?.includes('text/html'))throw new Error('The public not-found page is unavailable.');
  await inspect(missing);
  if(alias) {
    const preview=new URL(alias);
    if(preview.protocol!=='https:'||!preview.hostname.endsWith('.'+new URL(origin).hostname)) {
      throw new Error('Cloudflare returned an unexpected Pages deployment alias.');
    }
    const response=await request(preview.origin+'/api/health');
    if(response.status!==404)throw new Error('The Pages deployment alias did not reject application API access.');
    await inspect(response);
  }
  console.log('Canonical Pages routes, assets, API errors and origin checks passed.');
}

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
      category=(await (await http('/catalog')).json()).find(type=>!active.has(type.id))?.id;
      if(!category)throw new Error('No free equipment category on the dedicated smoke resident account.');
      owner=user.id;
      if(location?.useForRequests===false) throw new Error('The dedicated smoke resident has disabled its saved location.');
      if(!location && !(await http('/resident/location','PUT',{...pilot.center,label:marker,useForRequests:true})).ok) {
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
