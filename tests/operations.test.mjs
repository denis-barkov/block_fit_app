import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {database} from './database';
import {createAuth} from '../src/server/auth';
import {getComparison,inventory} from '../src/server/database';
import app from '../src/server/index';
import {createOperatorAccount,seedDataset} from '../scripts/fixtures.mjs';
import {setPassword} from '../scripts/accounts.mjs';
import {createSnapshot,restoreSnapshot} from '../scripts/snapshot.mjs';
import {applyTags,cloudflare,CloudflareError,validateAccount} from '../scripts/cloudflare.mjs';
import {remoteDatabase} from '../scripts/remote-d1.mjs';

const origin='http://127.0.0.1:8787';
const config={APP_ORIGIN:origin,AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID()};
const scenario={category:'pull-up',radius:200,budget:2_000_000,horizon:10,selected:['demo-a','demo-b']};
const password='initial synthetic passphrase';
const newPassword='replacement synthetic passphrase';
let source,target;
beforeAll(async()=>{
  source=await database();
  target=await database();
});
afterAll(async()=>{
  await Promise.all([source?.dispose(),target?.dispose()]);
});

it('round-trips private data into fresh D1, excludes sessions and freezes AI without rewinding spend',async()=>{
  const db=source.env.DB, fresh=target.env.DB;
  await seedDataset(db);
  const first=await getComparison(db,scenario);
  await seedDataset(db);
  expect((await getComparison(db,scenario)).revision).toBe(first.revision);
  const account=await createOperatorAccount(db,config,{email:'resident@snapshot.example',name:'Snapshot test',role:'resident',password});
  const resident=account.user.id;
  await db.batch([
    db.prepare("INSERT INTO locations VALUES(?,40.7192,-73.8461,'Pilot test','2026-11-18',0)").bind(resident),
    db.prepare("INSERT INTO removed_locations VALUES('removed',?,40.710,-74.054,'Old pin','2026-11-18')").bind(resident),
    db.prepare("INSERT INTO demand(id,owner,category,lat,lng,status,created_at,confirmed_at) VALUES('private',?,'pull-up',40.7192,-73.8461,'recorded','2026-11-18','2026-11-18')").bind(resident),
    db.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('test-session','2099-01-01','synthetic-session-token','2026-11-18','2026-11-18',?)").bind(resident),
    db.prepare('UPDATE ai_total SET spent=75 WHERE id=1'),
    db.prepare("INSERT INTO ai_day VALUES ('2026-11-18',7)"),
  ]);
  const snapshot=await createSnapshot(db,'private');
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-session-token');
  const sanitized=await createSnapshot(db,'demo');
  expect(JSON.stringify(sanitized)).not.toContain('resident@snapshot.example');
  await fresh.prepare('UPDATE ai_total SET spent=100 WHERE id=1').run();
  await expect(restoreSnapshot(fresh,{...snapshot,migration:'unknown'})).rejects.toThrow('incompatible');
  const before=await getComparison(db,scenario);
  await restoreSnapshot(fresh,snapshot);
  await expect(restoreSnapshot(fresh,snapshot)).rejects.toThrow('empty target');
  const {equipment_types,type_proposals,program_goals,...legacyRecords}=snapshot.records;
  legacyRecords.candidates=legacyRecords.candidates.map(({estimated_start,estimated_ready,...row})=>row);
  await expect(restoreSnapshot(fresh,{...snapshot,records:legacyRecords,version:'0.2.2',
    migration:'0005_resident_travel.sql'})).rejects.toThrow('empty target');
  expect(await inventory(fresh,null,'')).toEqual(await inventory(db,null,''));
  expect(await getComparison(fresh,scenario)).toMatchObject({demandCount:before.demandCount,unmet:before.unmet,options:before.options});
  expect(await fresh.prepare('SELECT use_for_requests FROM locations').first('use_for_requests')).toBe(0);
  expect(await fresh.prepare('SELECT lat,lng,removed_at FROM removed_locations').first()).toEqual({lat:40.710,lng:-74.054,removed_at:'2026-11-18'});
  expect(await fresh.prepare('SELECT count(*) n FROM session').first('n')).toBe(0);
  expect(await fresh.prepare('SELECT spent FROM ai_total').first('spent')).toBe(100);
  expect(await fresh.prepare('SELECT attempts FROM ai_day').first('attempts')).toBe(7);
  expect(await fresh.prepare('SELECT suspended,ai_frozen FROM operations').first()).toEqual({suspended:1,ai_frozen:1});
  const worker={DB:fresh,...config,ASSETS:{fetch:async()=>new Response('assets')}};
  expect((await app.request(origin+'/',{},worker)).status).toBe(503);
  expect((await app.request(origin+'/assets/file.js',{},worker)).status).toBe(503);
  await fresh.prepare('UPDATE operations SET suspended=0').run();
  expect((await app.request(origin+'/api/inventory',{},worker)).status).toBe(200);
});

it('upgrades a 0.0.6 snapshot with its existing saved location enabled',async()=>{
  const old=await database();
  try {
    const snapshot=await createSnapshot(source.env.DB,'private');
    snapshot.version='0.0.6';
    snapshot.migration='0003_demo_and_account_purpose.sql';
    delete snapshot.records.removed_locations;
    delete snapshot.records.equipment_types;
    delete snapshot.records.type_proposals;
    delete snapshot.records.program_goals;
    snapshot.records.candidates=snapshot.records.candidates.map(({estimated_start,estimated_ready,...row})=>row);
    for(const row of snapshot.records.locations) delete row.use_for_requests;
    await restoreSnapshot(old.env.DB,snapshot);
    expect(await old.env.DB.prepare('SELECT use_for_requests FROM locations').first('use_for_requests')).toBe(1);
  } finally {await old.dispose();}
});

it('uses maintained password hashing and revokes prior sessions on operator reset',async()=>{
  const db=source.env.DB;
  const auth=createAuth({DB:db,...config});
  const login=email=>({body:{email,password},headers:new Headers({Origin:origin})});
  const email='resident@snapshot.example';
  const original=await auth.api.signInEmail({...login(email),asResponse:true});
  expect(original.ok).toBe(true);
  const cookies=new Headers({Cookie:original.headers.getSetCookie().map(line=>line.split(';',1)[0]).join('; ')});
  const before=await auth.api.getSession({headers:cookies});
  expect(before.user.email).toBe(email);
  await setPassword(db,config,before.user.id,newPassword);
  expect(await auth.api.getSession({headers:cookies})).toBeNull();
  await expect(auth.api.signInEmail(login(email))).rejects.toThrow();
  expect((await auth.api.signInEmail({body:{email,password:newPassword}})).user.id).toBe(before.user.id);
});

it('checks deployment scope and preserves existing tags while surfacing provider failures',async()=>{
  const env={CLOUDFLARE_ACCOUNT_ID:'account-id',CLOUDFLARE_API_TOKEN:'mock',
    PROJECT_NAME:'blockfit-nyc',MANAGED_BY:'script',DEPLOYMENT:'prod',FUNDING:'personal',
    resourceName:'blockfit-nyc-prod'};
  const transport=vi.fn(async(url,init)=>{
    const path=new URL(url).pathname.replace('/client/v4/accounts/account-id','');
    if (path==='') return Response.json({success:true,result:{id:'account-id'}});
    if (path==='/tags'&&init.method==='GET') return Response.json({success:true,result:{tags:{owner:'different',environment:'old'}}});
    if (path==='/tags'&&init.method==='PUT') return Response.json({success:true,result:JSON.parse(init.body)});
    return new Response(null,{status:403});
  });
  const call=cloudflare(env,transport);
  await validateAccount(call,env);
  await expect(validateAccount(call,{...env,CLOUDFLARE_ACCOUNT_ID:'different'})).rejects.toThrow('configured account');
  await applyTags(call,env,'worker',env.resourceName,false);
  expect(JSON.parse(transport.mock.calls.at(-1)[1].body)).toEqual({
    resource_type:'worker',resource_id:env.resourceName,
    tags:{owner:'different',environment:'prod','managed-by':'script','project-name':'blockfit-nyc',funding:'personal'},
  });
  await expect(call('/forbidden')).rejects.toBeInstanceOf(CloudflareError);
});

it('supports the production operator path with parameterized D1 batch requests',async()=>{
  const db=target.env.DB;
  const transport=vi.fn(async(_path,method,{batch})=>{
    expect(method).toBe('POST');
    return db.batch(batch.map(({sql,params=[]})=>db.prepare(sql).bind(...params)));
  });
  const remote=remoteDatabase(transport,'mock-id');
  const email='staff-operator@blockfit.example';
  const staff=await createOperatorAccount(remote,config,{email,name:'Operator fixture',role:'staff',password});
  expect(staff.user.role).toBe('staff');
  await setPassword(remote,config,staff.user.id,newPassword);
  const session=await createAuth({DB:db,...config}).api.signInEmail({body:{email,password:newPassword}});
  expect(session.user.role).toBe('staff');
});
