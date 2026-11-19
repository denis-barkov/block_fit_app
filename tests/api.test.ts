import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { appIdentity,comparisonBriefFilename } from '../config/app';
import { limits,pilot,planning } from '../config/settings';
import { createAuth } from '../src/server/auth';
import app from '../src/server/index';
import type { Demand,PublicEquipment,SavedLocation } from '../src/contracts';
import type { Comparison } from '../src/server/planning';
import type { Env } from '../src/server/web';
import { database } from './database';

const ORIGIN='http://127.0.0.1:8787';
const password='test passphrase that is long enough';
const scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
const request={category:'pull-up',note:'confidential test fixture',suggestion:'',point:null};
let proxy:Awaited<ReturnType<typeof database>>;
let env:Env;
type ResidentState={location:SavedLocation|null;requests:Demand[]};
type Session={user:{role:string}|null};
const json=<T>(response: Response)=>response.json() as Promise<T>;
function client(initial='') {
  let cookie=initial;
  return {
    send:async(path:string,method='GET',body?:unknown,origin=ORIGIN)=>{
      const response=await app.request(ORIGIN+'/api'+path,{method,
        headers:{Origin:origin,...cookie&&{Cookie:cookie},...body!==undefined&&{'Content-Type':'application/json'}},
        body:body!==undefined?JSON.stringify(body):undefined},env);
      const received=response.headers.getSetCookie();
      if(received.length)cookie=received.map(line=>line.split(';',1)[0]).join('; ');
      return response;
    },
    cookie:()=>cookie,
  };
}
async function register(email:string) {
  const resident=client();
  const response=await resident.send('/auth/sign-up/email','POST',{email,name:'Test resident',password,confirmation:password});
  expect(response.status,await response.clone().text()).toBe(200);
  return resident;
}
async function location(clientInstance:ReturnType<typeof client>,point=pilot.center) {
  expect((await clientInstance.send('/resident/location','PUT',{...point,label:'Test origin',useForRequests:true})).ok).toBe(true);
}
function move(clientInstance:ReturnType<typeof client>,point:{lat:number;lng:number},activeRequests:number) {
  return clientInstance.send('/resident/location/move','POST',{...point,label:'Moved pin',activeRequests});
}
let a:ReturnType<typeof client>,b:ReturnType<typeof client>,staff:ReturnType<typeof client>;
beforeAll(async()=>{
  proxy=await database();
  env={DB:proxy.env.DB,APP_ORIGIN:ORIGIN,AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),DEPLOYMENT:'local',
    ASSETS:{fetch:()=>Promise.resolve(new Response('test assets')),connect:()=>{throw new Error('Unused');}} as Fetcher};
  a=await register('a@blockfit.example');
  b=await register('b@blockfit.example');
  await createAuth(env).api.createUser({body:{email:'staff@blockfit.example',name:'Staff test',password,role:'staff'}});
  staff=client();
  const response=await staff.send('/auth/sign-in/email','POST',{email:'staff@blockfit.example',password});
  expect(response.status,await response.clone().text()).toBe(200);
});
afterAll(async()=>{await proxy?.dispose();});

describe('connected Worker API and D1',()=>{
  const inventory={...pilot.center,name:'Test bars',category:'pull-up',parkId:null,condition:'usable',access:'public',
    source:'Fictional fixture',verifiedOn:'2026-01-01',visible:true};
  const candidate={...pilot.center,name:'Test candidate',category:'pull-up',parkId:null,feasibility:'suitable-for-comparison',notes:'',
    projectUrl:null,costs:{equipment:{low:0,base:100,high:200},installation:null,preparation:null,accessibility:null,
      maintenance:null,replacement:null,interval:null,replacementPlan:'none',source:'Test assumptions'}};
  it('blocks unauthenticated, resident, spoofed-origin, unknown auth actions and public role escalation',async()=>{
    expect((await client().send('/staff/inventory')).status).toBe(401);
    expect((await client().send('/resident')).status).toBe(401);
    expect((await a.send('/staff/inventory')).status).toBe(403);
    expect((await staff.send('/resident')).status).toBe(403);
    expect((await a.send('/resident/location','PUT',{...pilot.center,label:'',confirmed:true},'https://example.test')).status).toBe(403);
    expect((await a.send('/auth/admin/create-user','POST',{})).status).toBe(404);
    expect((await a.send('/auth/sign-up/email','POST',{name:'Escalation attempt',email:'c@blockfit.example',password,confirmation:password,role:'staff'})).status).toBe(400);
    expect((await json<Session>(await a.send('/me'))).user?.role).toBe('resident');
  });
  it('connects requests, atomic location changes, staff inventory and a revision-safe export',async()=>{
    expect((await a.send('/resident/requests','POST',request)).status).toBe(409);
    await location(a);
    await location(b);
    const raced=await Promise.all([a.send('/resident/requests','POST',request),a.send('/resident/requests','POST',request)]);
    expect(raced.map(item=>item.status).sort()).toEqual([201,409]);
    const {id}=await json<{id:string}>(raced.find(item=>item.status===201)!);
    expect((await b.send('/resident/requests/'+id,'PUT',request)).status).toBe(404);
    expect((await b.send('/resident/requests/'+id+'/withdraw','POST',{})).status).toBe(404);
    expect((await json<ResidentState>(await b.send('/resident'))).requests).toEqual([]);
    const created=await staff.send('/staff/inventory/candidates','POST',candidate);
    expect(created.status,await created.clone().text()).toBe(201);
    const siteId=(await json<{id:string}>(created)).id;
    const first=await json<Comparison>(await staff.send('/staff/compare','POST',scenario));
    expect(first).toMatchObject({demandCount:1,unmet:1,options:[{count:1,estimates:{base:{lifecycle:null}}}]});
    const ref={scenario,revision:first.revision,calculatedAt:first.calculatedAt};
    const exported=await staff.send('/staff/export','POST',ref);
    expect(exported.headers.get('Content-Disposition')).toBe(`attachment; filename="${comparisonBriefFilename}"`);
    const brief=await exported.text();
    expect(brief).toContain(`# ${appIdentity.name} investment comparison`);
    expect(brief).toContain('Unique newly covered requesters: 1');
    expect(brief).not.toContain(request.note);
    expect((await staff.send('/staff/explain','POST',ref)).status).toBe(503);
    expect((await a.send('/resident/requests/'+id+'/withdraw','POST',{})).ok).toBe(true);
    const other={lat:pilot.center.lat+.004,lng:pilot.center.lng};
    expect((await move(a,other,0)).ok).toBe(true);
    expect((await json<ResidentState>(await a.send('/resident'))).requests[0].lat).toBe(pilot.center.lat);
    expect((await a.send('/resident/requests','POST',request)).status).toBe(201);
    expect((await a.send('/resident/requests/'+id+'/restore','POST',{})).status).toBe(409);
    const current=(await json<ResidentState>(await a.send('/resident'))).requests.find(entry=>entry.status==='recorded')!;
    await a.send('/resident/requests/'+current.id+'/withdraw','POST',{});
    expect((await a.send('/resident/requests/'+id+'/restore','POST',{})).ok).toBe(true);
    expect((await a.send('/resident/requests/'+id+'/reconfirm','POST',{})).ok).toBe(true);
    expect((await json<ResidentState>(await a.send('/resident'))).requests.find(entry=>entry.id===id)?.lat).toBe(other.lat);
    await env.DB.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON demand BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    try {
      expect((await move(a,pilot.center,1)).status).toBe(500);
      expect((await json<ResidentState>(await a.send('/resident'))).location?.lat).toBe(other.lat);
    } finally {await env.DB.exec('DROP TRIGGER fixture_fail');}
    expect((await move(a,pilot.center,1)).ok).toBe(true);
    const createEquipment=await staff.send('/staff/inventory/equipment','POST',inventory);
    expect(createEquipment.status,await createEquipment.clone().text()).toBe(201);
    const {id:equipmentId}=await json<{id:string}>(createEquipment);
    const visible=await json<PublicEquipment[]>(await client().send('/inventory?category=pull-up&q=test'));
    expect(visible).toMatchObject([{name:'Test bars',park:null}]);
    expect(Object.keys(visible[0]).sort()).toEqual(['id','name','lat','lng','category','categoryName','categoryActive',
      'condition','access','source','verifiedOn','park','fixture'].sort());
    expect((await json<Comparison>(await staff.send('/staff/compare','POST',scenario))).unmet).toBe(0);
    expect((await staff.send('/staff/export','POST',ref)).status).toBe(409);
    expect((await staff.send('/staff/inventory/equipment/'+equipmentId,'PUT',{...inventory,lat:95})).status).toBe(400);
    expect((await staff.send('/staff/inventory/equipment/'+equipmentId,'PUT',{...inventory,condition:'unknown'})).status).toBe(200);
    expect((await json<Comparison>(await staff.send('/staff/compare','POST',scenario))).unmet).toBe(1);
    expect((await staff.send('/staff/inventory/candidates/'+siteId,'PUT',{...candidate,projectUrl:'javascript:alert(1)'})).status).toBe(400);
    expect((await staff.send('/staff/inventory/candidates/'+siteId,'PUT',{...candidate,costs:{...candidate.costs,equipment:{low:20,base:10,high:30}}})).status).toBe(400);
    expect((await staff.send('/staff/inventory/candidates/'+siteId,'PUT',{...candidate,category:'parallel'})).status).toBe(200);
    expect((await staff.send('/staff/compare','POST',{...scenario,selected:[siteId]})).status).toBe(400);
    expect((await staff.send('/staff/inventory/candidates/'+siteId,'DELETE')).status).toBe(200);
    expect((await staff.send('/staff/inventory/equipment/'+equipmentId,'DELETE')).status).toBe(200);
    expect(await (await client().send('/inventory')).json()).toEqual([]);
  });
  it('only generates for staff on request and preserves the deterministic comparison after invalid output',async()=>{
    const amount={low:100,base:100,high:100};
    const record=await staff.send('/staff/inventory/candidates','POST',{...candidate,costs:{...candidate.costs,
      installation:amount,preparation:amount,accessibility:amount,maintenance:amount}});
    expect(record.status).toBe(201);
    const {id:siteId}=await json<{id:string}>(record);
    const settings={...env};
    Object.assign(env,{AI_ENABLED:'true',OPENAI_MODEL:'gpt-6-luna',OPENAI_REASONING_EFFORT:'low',OPENAI_API_KEY:'test-only'});
    await env.DB.prepare("INSERT INTO throttle(key,window,attempts) SELECT 'ai:'||id,?,100 FROM user WHERE role='staff'")
      .bind(Math.floor(Date.now()/600_000)).run();
    const realFetch=globalThis.fetch;
    const responseBody={summary:'Test candidate leads on modeled lifecycle cost per additional requester.',tradeoffs:'',checks:'',
      referencedOptionIds:[siteId]};
    const openai=vi.fn(async (url:string, init?:RequestInit)=>{
      const payload=JSON.parse(String(init?.body));
      const input=payload.input[1].content;
      const snapshot=JSON.parse(input);
      expect(snapshot.ranking.highlightedOptionIds).toEqual([siteId]);
      expect(payload.text.format.schema.required).not.toContain('highlightedOptionIds');
      expect(snapshot.options[0]).toMatchObject({id:siteId,name:'Test candidate',highlightEligible:true});
      expect(input).not.toContain(request.note);
      if(url.endsWith('/input_tokens')) return Response.json({input_tokens:450});
      return Response.json({status:'completed',usage:{input_tokens:450,output_tokens:100},
        output:[{content:[{type:'output_text',text:JSON.stringify(responseBody)}]}]});
    });
    vi.stubGlobal('fetch',(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=input instanceof Request ? input.url : String(input);
      return url.startsWith('https://api.openai.com/') ? openai(url,init) : realFetch(input,init);
    });
    try {
      const comparison=await json<Comparison>(await staff.send('/staff/compare','POST',scenario));
      const ref={scenario,revision:comparison.revision,calculatedAt:comparison.calculatedAt};
      expect((await client().send('/staff/explain','POST',ref)).status).toBe(401);
      expect((await a.send('/staff/explain','POST',ref)).status).toBe(403);
      expect((await client().send('/inventory')).ok).toBe(true);
      expect(openai).not.toHaveBeenCalled();
      responseBody.referencedOptionIds=['unknown'];
      expect((await staff.send('/staff/explain','POST',ref)).status).toBe(502);
      const unchanged=await json<Comparison>(await staff.send('/staff/compare','POST',scenario));
      expect(unchanged).toEqual({...comparison,calculatedAt:unchanged.calculatedAt});
      responseBody.referencedOptionIds=[siteId,siteId];
      const explanation={...responseBody,referencedOptionIds:[siteId],highlightedOptionIds:[siteId]};
      expect((await staff.send('/staff/explain','POST',ref)).status).toBe(429);
      await env.DB.exec('UPDATE ai_staff_usage SET started=0');
      expect(await (await staff.send('/staff/explain','POST',ref)).json()).toEqual(explanation);
      expect(await (await staff.send('/staff/compare','POST',scenario)).json()).toMatchObject({explanation});
      expect(openai).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
      Object.assign(env,{...settings,AI_ENABLED:undefined,OPENAI_API_KEY:undefined});
      await staff.send('/staff/inventory/candidates/'+siteId,'DELETE');
    }
  });

  it('accepts Brooklyn and Queens pins and safely toggles, moves and archives a resident location',async()=>{
    const resident=await register('regional@blockfit.example');
    const coney={lat:40.5756,lng:-73.9805};
    const queens={lat:40.7528,lng:-73.7449};
    const saved={...coney,label:'Coney Island fixture',useForRequests:true};
    expect(await (await client().send('/inventory')).json()).toEqual([]);
    expect((await resident.send('/resident/location','PUT',saved)).status).toBe(200);
    const second={...request,category:'sit-up'};
    const {id}=await json<{id:string}>(await resident.send('/resident/requests','POST',second));
    expect(id).toBeTruthy();
    const sit={...scenario,category:'sit-up'};
    const before=await json<Comparison>(await staff.send('/staff/compare','POST',sit));
    expect(before.origins).toMatchObject([{...coney,covered:false}]);
    expect((await resident.send('/resident/location','PUT',{...saved,useForRequests:false})).ok).toBe(true);
    expect((await resident.send('/resident/requests','POST',{...request,category:'parallel'})).status).toBe(409);
    expect((await resident.send('/resident/location','DELETE')).status).toBe(409);
    expect((await staff.send('/resident/location','DELETE')).status).toBe(403);
    expect((await client().send('/resident/location','DELETE')).status).toBe(401);
    expect((await resident.send('/resident/location','PUT',{...saved,...queens})).status).toBe(409);
    expect((await move(resident,queens,0)).status).toBe(409);
    const stayed=await json<ResidentState>(await resident.send('/resident'));
    expect(stayed).toMatchObject({location:{...coney,useForRequests:false},requests:[{id,status:'recorded',...coney}]});
    expect((await move(resident,queens,1)).ok).toBe(true);
    const moved=await json<Comparison>(await staff.send('/staff/compare','POST',sit));
    expect(moved.origins).toMatchObject([{...queens,covered:false}]);
    expect(moved.revision).toBeGreaterThan(before.revision);
    const create=await staff.send('/staff/inventory/equipment','POST',{...inventory,...queens,name:'Queens fixture',category:'sit-up'});
    expect(create.status).toBe(201);
    const {id:equipmentId}=await json<{id:string}>(create);
    expect(await (await client().send('/inventory?q=Queens%20fixture')).json()).toMatchObject([{id:equipmentId,...queens}]);
    expect((await json<Comparison>(await staff.send('/staff/compare','POST',sit))).unmet).toBe(0);
    expect((await resident.send('/resident/location','PUT',{...saved,lat:42})).status).toBe(400);
    expect((await resident.send('/resident/requests/'+id+'/withdraw','POST',{})).ok).toBe(true);
    expect((await resident.send('/resident/location','DELETE')).ok).toBe(true);
    const removed=await json<ResidentState>(await resident.send('/resident'));
    expect(removed).toMatchObject({location:null,requests:[{id,status:'withdrawn',...queens}]});
    expect(await env.DB.prepare('SELECT lat,lng,removed_at FROM removed_locations').first()).toMatchObject({
      ...queens,removed_at:expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect((await resident.send('/resident/requests/'+id+'/restore','POST',{})).status).toBe(404);
    expect((await json<ResidentState>(await b.send('/resident'))).location).toMatchObject(pilot.center);
    expect((await staff.send('/staff/inventory/equipment/'+equipmentId,'DELETE')).ok).toBe(true);
  });

  it('rejects out-of-service pins from clients and preserves existing requests with legacy pins',async()=>{
    const resident=await register('boroughs@blockfit.example');
    const manhattan={lat:40.714,lng:-74.008};
    const jersey={lat:40.710,lng:-74.054};
    for(const point of [manhattan,jersey,{lat:40.826,lng:-73.924},{lat:40.638,lng:-74.083},{lat:40.7045,lng:-73.992}]) {
      const pin={...point,label:'Out-of-area fixture',useForRequests:true};
      const result=await resident.send('/resident/location','PUT',pin);
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({error:'Choose a pin in Brooklyn and Queens.'});
      expect((await staff.send('/staff/inventory/equipment','POST',{...inventory,...point})).status).toBe(400);
    }
    expect((await staff.send('/staff/inventory/parks','POST',{...manhattan,name:'Outside',externalId:'',source:'',hours:'',cityMaintained:false})).status).toBe(400);
    expect((await staff.send('/staff/inventory/candidates','POST',{...candidate,...jersey})).status).toBe(400);
    await location(resident,{lat:40.5862,lng:-73.811});
    expect((await resident.send('/resident/requests','POST',{...request,point:manhattan})).status).toBe(400);
    const created=await resident.send('/resident/requests','POST',request);
    expect(created.status).toBe(201);
    const {id}=await json<{id:string}>(created);
    // Reproduce a saved pin accepted by 0.1.0. Its location trigger moves the stored request as before.
    await env.DB.prepare("UPDATE locations SET lat=?,lng=? WHERE owner=(SELECT id FROM user WHERE email='boroughs@blockfit.example')")
      .bind(jersey.lat,jersey.lng).run();
    expect((await resident.send('/resident/requests','POST',{...request,category:'parallel'})).status).toBe(409);
    expect((await move(resident,manhattan,1)).status).toBe(400);
    const state=await json<ResidentState>(await resident.send('/resident'));
    expect(state.requests).toMatchObject([{id,status:'recorded',...jersey}]);
    expect((await resident.send('/resident/requests/'+id+'/withdraw','POST',{})).ok).toBe(true);
    expect((await resident.send('/resident/requests/'+id+'/restore','POST',{})).status).toBe(409);
    expect((await move(resident,{lat:40.7528,lng:-73.7449},0)).ok).toBe(true);
    expect((await resident.send('/resident/requests/'+id+'/restore','POST',{})).ok).toBe(true);
  });

  it('rejects duplicates, changes passwords securely and persists throttling',async()=>{
    const duplicate=await client().send('/auth/sign-up/email','POST',{email:'a@blockfit.example',name:'Duplicate',password,confirmation:password});
    expect([400,409,422]).toContain(duplicate.status);
    const newPassword='a different and longer test passphrase';
    expect((await b.send('/auth/change-password','POST',{currentPassword:'incorrect',newPassword,confirmation:newPassword})).ok).toBe(false);
    const changed=await b.send('/auth/change-password','POST',{currentPassword:password,newPassword,confirmation:newPassword});
    expect(changed.status,await changed.clone().text()).toBe(200);
    await b.send('/auth/sign-out','POST',{});
    expect((await json<Session>(await b.send('/me'))).user).toBeNull();
    expect((await b.send('/auth/sign-in/email','POST',{email:'b@blockfit.example',password:newPassword})).ok).toBe(true);
    for(let n=0;n<6;n++) {
      expect((await client().send('/auth/sign-in/email','POST',{email:'bad@blockfit.example',password})).status).toBe(401);
    }
    expect((await client().send('/auth/sign-in/email','POST',{email:'bad@blockfit.example',password})).status).toBe(429);
    expect((await client().send('/auth/sign-up/email','POST',{email:'short@blockfit.example',name:'Short',password:'x'.repeat(limits.minPassword-1),confirmation:'x'})).status).toBe(400);
  });
});
