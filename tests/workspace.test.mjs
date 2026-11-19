import { isInServiceArea } from '../config/map-area.ts';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {unstable_splitSqlQuery} from 'wrangler';
import {demoDemand,demoVersion,legacyDemandIds} from '../config/demo.ts';
import {pilot,planning} from '../config/settings.ts';
import {createAuth} from '../src/server/auth';
import {getComparison,inventory} from '../src/server/database';
import {metres} from '../src/server/planning';
import app from '../src/server/index';
import {returnPath} from '../src/routes';
import {accountPlan,applyAccountPlan,validateDefinitions} from '../scripts/accounts.mjs';
import {createOperatorAccount,demoPlan,seedDataset} from '../scripts/fixtures.mjs';
import {production} from '../scripts/production.mjs';
import {smoke} from '../scripts/smoke.mjs';
import {database} from './database';

const origin='http://127.0.0.1:8787';
const password='one synthetic passphrase for local QA';
const config={APP_ORIGIN:origin,AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),DEPLOYMENT:'local'};
const scenario={category:'pull-up',radius:planning.radius,budget:planning.budget,horizon:planning.horizon,selected:['demo-a','demo-b']};
let proxy,db,env;
beforeAll(async()=>{
  proxy=await database();db=proxy.env.DB;
  env={DB:db,...config,ASSETS:{fetch:async()=>new Response('<html>BlockFit shell</html>')}};
});
afterAll(async()=>{await proxy?.dispose();});
const fetchApp=(url,init)=>app.request(url,init,env);
async function signIn(email) {
  const response=await fetchApp(origin+'/api/auth/sign-in/email',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password}),
  });
  expect(response.status).toBe(200);
  const cookie=response.headers.getSetCookie().map(line=>line.split(';',1)[0]).join('; ');
  return (path,method='GET',data)=>fetchApp(origin+path,{method,headers:{Origin:origin,Cookie:cookie,
    ...data&&{'Content-Type':'application/json'}},body:data&&JSON.stringify(data)});
}
const definitions=validateDefinitions(JSON.parse(readFileSync('config/accounts.example.json','utf8')));

it('produces reproducible land clusters and materially different investment outcomes',async()=>{
  expect(demoDemand()).toEqual(demoDemand());
  const points=demoDemand();
  expect(new Set(points.map(point=>point.lat+','+point.lng)).size).toBe(points.length);
  expect(points.every(isInServiceArea)).toBe(true);
  expect(Math.max(...points.map(p=>p.lat))-Math.min(...points.map(p=>p.lat))).toBeGreaterThan(.008);
  expect(Math.max(...points.map(p=>p.lng))-Math.min(...points.map(p=>p.lng))).toBeGreaterThan(.009);
  expect(points.some(p=>points.filter(other=>metres(p,other)<70).length>=6)).toBe(true);
  await seedDataset(db);
  const plan=await demoPlan(db);
  expect(plan).toMatchObject({version:demoVersion,counts:{parks:8,equipment:29,candidates:15,synthetic_demand:153}});
  const result=await getComparison(db,scenario);
  const option=id=>result.options.find(entry=>entry.ids.join(',')===id);
  expect(result.unmet).toBeGreaterThan(option('demo-a,demo-b').count);
  expect(result.demandCount).toBeGreaterThan(result.unmet);
  expect(result.origins.some(origin=>origin.synthetic&&origin.covered)).toBe(true);
  expect(option('demo-a,demo-b').count).toBeGreaterThan(Math.max(option('demo-a').count,option('demo-b').count));
  expect(option('demo-a,demo-b').count).toBeLessThan(option('demo-a').count+option('demo-b').count);
  expect(option('demo-a,demo-b').overlap).toBeGreaterThan(0);
  expect(option('demo-a,demo-b').estimates.base.fits).toBe(false);
  expect(option('demo-pull-distant')).toMatchObject({count:0,estimates:{base:{perRequester:null}}});
  expect(option('demo-pull-premium').estimates.base).toMatchObject({fits:false,lifecycle:null});
  expect(result.highlighted).toHaveLength(1);
  const equipment=await inventory(db,null,'');
  expect(equipment.every(item=>item.fixture)).toBe(true);
  expect(equipment.some(item=>item.park===null && !item.verifiedOn)).toBe(true);
  expect(equipment.some(item=>item.condition==='unusable')).toBe(true);
  await seedDataset(db,{update:true});
  expect((await getComparison(db,scenario)).revision).toBe(result.revision);
});

it('upgrades the original fixture without changing manual inventory or account records',async()=>{
  const legacy=await database(false);
  try {
    const d=legacy.env.DB;
    await d.batch([
      d.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt,role) VALUES ('human','Real staff','human@example.com','2026-11-17','2026-11-17','staff')"),
      d.prepare("INSERT INTO parks(id,name,lat,lng,external_id,source,hours) VALUES('demo-west','Old fixture',40.719,-73.85,'','','')"),
      d.prepare("INSERT INTO equipment(id,name,category,lat,lng,park_id,condition,access,source,visible) VALUES('human-equipment','Manual entry','pull-up',40.719,-73.85,'demo-west','unknown','unknown','',1)"),
      d.prepare("INSERT INTO synthetic_demand VALUES(?,'pull-up',40.719,-73.85)").bind(legacyDemandIds[0]),
      d.prepare("INSERT INTO demand(id,owner,category,lat,lng,status,created_at,confirmed_at) VALUES('human-request','human','parallel',40.719,-73.85,'recorded','2026-11-17','2026-11-17')"),
    ]);
    const migration=readFileSync('migrations/0003_demo_and_account_purpose.sql','utf8');
    await d.batch(unstable_splitSqlQuery(migration).map(sql=>d.prepare(sql)));
    expect((await demoPlan(d)).version).toBe(1);
    await seedDataset(d);
    expect((await demoPlan(d)).version).toBe(1);
    await seedDataset(d,{update:true});
    expect((await demoPlan(d)).version).toBe(demoVersion);
    expect(await d.prepare('SELECT id FROM synthetic_demand WHERE id=?').bind(legacyDemandIds[0]).first()).toBeNull();
    expect(await d.prepare("SELECT name,park_id,fixture FROM equipment WHERE id='human-equipment'").first()).toEqual({name:'Manual entry',park_id:'demo-west',fixture:0});
    expect(await d.prepare("SELECT role,purpose FROM user WHERE id='human'").first()).toEqual({role:'staff',purpose:null});
    expect(await d.prepare("SELECT id FROM demand WHERE id='human-request'").first('id')).toBe('human-request');
  } finally{await legacy.dispose();}
});

it('validates provisioning input, preserves passwords and rejects the collision with a public login',async()=>{
  expect(()=>validateDefinitions([{...definitions[0],role:'admin'}])).toThrow('Invalid');
  expect(()=>validateDefinitions([{...definitions[0],email:'invalid'}])).toThrow('Invalid');
  expect(()=>validateDefinitions([{...definitions[0],password}])).toThrow('Password fields');
  expect(()=>validateDefinitions([definitions[0],{...definitions[0],email:definitions[0].email.toUpperCase()}])).toThrow('Duplicate');
  const planned=await accountPlan(db,definitions);
  expect(planned.every(row=>row.action==='create')).toBe(true);
  await applyAccountPlan(db,config,planned,async()=>password);
  const next=await accountPlan(db,definitions.map((entry,index)=>index===0?{...entry,name:'Updated presenter'}:entry));
  expect(next.map(row=>row.action)).toEqual(['update display name','keep','keep','keep']);
  const prompt=vi.fn();
  await applyAccountPlan(db,config,next,prompt);
  expect(prompt).not.toHaveBeenCalled();
  const staff=await signIn(definitions[0].email);
  expect(await (await staff('/api/me')).json()).toMatchObject({user:{name:'Updated presenter',role:'staff',purpose:'presentation'}});
  const auth=createAuth(env);
  const email='public-collision@example.com';
  await auth.api.signUpEmail({body:{email,name:'Public resident',password}});
  const conflict=await accountPlan(db,[{...definitions[0],email}]);
  expect(conflict[0].action).toBe('conflict');
  await expect(applyAccountPlan(db,config,conflict,prompt)).rejects.toThrow('conflicts');
  expect(await db.prepare('SELECT role,purpose FROM user WHERE email=?').bind(email).first()).toEqual({role:'resident',purpose:null});
});

it('guards both staff loaders and APIs, validates return paths and preserves an existing session',async()=>{
  for(const [path,redirect] of [['/city','/staff'],['/staff','/staff/login?returnTo=%2Fstaff'],
    ['/staff/inventory','/staff/login?returnTo=%2Fstaff%2Finventory'],
    ['/requests?category=parallel','/login?returnTo=%2Frequests%3Fcategory%3Dparallel']]) {
    const result=await fetchApp(origin+path);
    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe(redirect);
  }
  expect(returnPath('staff','//external.example/staff')).toBe('/staff');
  expect(returnPath('resident','https://external.example/requests')).toBe('/requests');
  expect(returnPath('resident','/requests?category=parallel&returnTo=//external.example')).toBe('/requests?category=parallel');
  const res=await signIn('public-collision@example.com');
  expect((await res('/staff')).status).toBe(403);
  expect((await res('/api/staff/compare','POST',scenario)).status).toBe(403);
  expect((await res('/api/auth/sign-in/email','POST',{email:definitions[0].email,password})).status).toBe(409);
  expect(await (await res('/api/me')).json()).toMatchObject({user:{role:'resident',purpose:null}});
  const invalid=await fetchApp(origin+'/api/auth/sign-up/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({name:'Bad',email:'test@example.com',password,confirmation:password,purpose:'automated-test'})});
  expect(invalid.status).toBe(400);
});

it('isolates automated smoke records, permissions and revisions, including cleanup on failure',async()=>{
  const resident=await signIn('public-collision@example.com');
  expect((await resident('/api/resident/location','PUT',{...pilot.center,label:'Private QA origin',confirmed:true})).ok).toBe(true);
  expect((await resident('/api/resident/requests','POST',{category:'pull-up',note:'',suggestion:'',point:null})).status).toBe(201);
  const before=await getComparison(db,scenario);
  expect(before.origins.filter(origin=>!origin.synthetic)).toHaveLength(1);
  const readCredentials=(_env,role)=>({email:definitions.find(row=>row.role===role&&row.purpose==='automated-test').email,password});
  const autoStaff=await signIn(readCredentials(env,'staff').email);
  expect((await autoStaff('/api/staff/inventory/equipment','POST',{})).status).toBe(403);
  expect((await autoStaff('/api/staff/explain','POST',{})).status).toBe(403);
  expect((await autoStaff('/staff/inventory')).headers.get('Location')).toBe('/staff');
  const smokeScenario={...scenario,selected:[]};
  const isolated=async()=> (await (await autoStaff('/api/staff/compare','POST',smokeScenario)).json()).demandCount;
  expect(await isolated()).toBe(0);
  await smoke(env,db,{transport:fetchApp,readCredentials});
  expect(await isolated()).toBe(0);
  const failure=async(url,init)=>url.endsWith('/staff/compare')?new Response(null,{status:503}):fetchApp(url,init);
  await expect(smoke(env,db,{transport:failure,readCredentials})).rejects.toThrow('comparison');
  expect(await isolated()).toBe(0);
  const after=await getComparison(db,scenario);
  expect(after.demandCount).toBe(before.demandCount);
  expect(after.revision).toBe(before.revision);
  expect(await db.prepare("SELECT count(*) AS n FROM locations WHERE label LIKE 'smoke-%'").first('n')).toBe(0);
});

it('provisions a fresh production target in preview mode using read-only lookups',async()=>{
  const account='00112233445566778899aabbccddeeff';
  const resourceName='blockfit-nyc-prod-workspace-dryrun';
  const remote={CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:'synthetic-token',resourceName,
    PAGES_PROJECT_NAME:'workspace-dryrun'};
  const transport=vi.fn(async(url,init)=>{
    expect(init.method).toBe('GET');
    const path=new URL(url).pathname.split(account)[1];
    if (!path) return Response.json({success:true,result:{id:account}});
    if(path==='/d1/database')return Response.json({success:true,result:[]});
    return new Response(null,{status:404});
  });
  vi.stubGlobal('fetch',transport);
  try {await production('provision',remote,['yes']);}
  finally {vi.unstubAllGlobals();}
  expect(transport).toHaveBeenCalledTimes(4);
});
