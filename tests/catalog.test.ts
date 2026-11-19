import { afterAll, beforeAll, expect, it } from 'vitest';
import { catalogLimits, pilot, planning } from '../config/settings';
import type { EquipmentType, ResidentProposal, StaffEquipmentType } from '../src/contracts';
import { createAuth } from '../src/server/auth';
import app from '../src/server/index';
import type { Env } from '../src/server/web';
import { database } from './database';

const origin='http://127.0.0.1:8787';
const password='catalog fixture passphrase';
const request={category:'pull-up',note:'',suggestion:'',point:null};
const scene=(category:string)=>({category,radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]});
const proposal=(name:string)=>({name,description:'Illustrative proposal',submissionKey:crypto.randomUUID(),
  note:'Private request note',suggestion:'Separate proposed site',point:{lat:40.719,lng:-73.85}});
let proxy:Awaited<ReturnType<typeof database>>;
let env:Env;
let db:D1Database;
type Client=ReturnType<typeof client>;
let staff:Client;
let a:Client;
let b:Client;
let aID:string;

function client(cookie='') {
  return (path:string,method='GET',data?:unknown)=>app.request(origin+'/api'+path,{method,headers:{
    Origin:origin,...cookie&&{Cookie:cookie},...data!==undefined&&{'Content-Type':'application/json'},
  },body:data===undefined?undefined:JSON.stringify(data)},env);
}
async function account(key:string,role:'staff'|'resident'='resident') {
  const email=key+'@catalog.example';
  const auth=createAuth(env);
  const {user}=await auth.api.createUser({body:{email,password,name:key,role}});
  const response=await auth.api.signInEmail({body:{email,password},headers:new Headers({Origin:origin}),asResponse:true});
  const call=client(response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; '));
  if(role==='resident')expect((await call('/resident/location','PUT',{...pilot.center,label:'Synthetic pin'})).ok).toBe(true);
  return {call,id:user.id};
}
async function send<T>(call:Client,path:string,method:string,data:unknown,status=200):Promise<T> {
  const response=await call(path,method,data);
  expect(response.status,await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}
const submit=(call:Client,name:string)=>send<{id:string}>(call,'/resident/proposals','POST',proposal(name),201);
const createType=(name:string)=>send<{id:string}>(staff,'/staff/types','POST',{name},201);
async function getType(id:string) {
  const {items}=await send<{items:StaffEquipmentType[]}>(staff,'/staff/types','GET',undefined);
  const found=items.find(type=>type.id===id);
  if(!found)throw new Error('Expected equipment type.');
  return found;
}
const updateType=(type:StaffEquipmentType,fields:Partial<StaffEquipmentType>,status=200)=>{
  const {id,...input}={...type,...fields,...(fields.name?{labelCorrection:true}:{})};
  return send(staff,'/staff/types/'+id,'PUT',input,status);
};
const review=(id:string,data:unknown)=>staff('/staff/proposals/'+id+'/decision','POST',data);
const history=(call:Client)=>send<{proposals:ResidentProposal[];requests:{id:string;categoryName:string;category:string;confirmedAt:string;note:string;categoryActive:boolean}[]}>(
  call,'/resident','GET',undefined);
const equipment={...pilot.center,name:'Synthetic catalog installation',parkId:null,condition:'usable',access:'public',
  source:'Synthetic catalog fixture',verifiedOn:'2026-01-01',visible:true};
const costs={equipment:null,installation:null,preparation:null,accessibility:null,maintenance:null,replacement:null,
  interval:null,replacementPlan:'unknown',source:''};
const candidate={...pilot.center,name:'Synthetic catalog candidate',parkId:null,feasibility:'suitable-for-comparison',
  notes:'',projectUrl:null,costs};

beforeAll(async()=>{
  proxy=await database();db=proxy.env.DB;
  env={DB:db,APP_ORIGIN:origin,AUTH_SECRET:'synthetic catalog test secret',ASSETS:{
    fetch:async()=>new Response('test'),connect:()=>{throw new Error('Unused');},
  }};
  staff=(await account('staff','staff')).call;
  ({call:a,id:aID}=await account('resident-a'));
  b=(await account('resident-b')).call;
});
afterAll(async()=>await proxy?.dispose());

it('shares stable types across inventory, demand, exports and planning, including inactive records',async()=>{
  const created=await createType('Calisthenics ladders');
  const category=created.id;
  const initial=await getType(category);
  const publicTypes=await send<EquipmentType[]>(client(),'/catalog','GET',undefined);
  expect(publicTypes.find(row=>row.id===category)).toEqual({id:category,name:'Calisthenics ladders',description:'',active:true});
  const site=await send<{id:string}>(staff,'/staff/inventory/candidates','POST',{...candidate,category},201);
  const existing=await send<{id:string}>(staff,'/staff/inventory/equipment','POST',{...equipment,category},201);
  const recorded=await send<{id:string}>(a,'/resident/requests','POST',{...request,category},201);
  const compare=()=>send<{revision:number;calculatedAt:string;demandCount:number;options:{estimates:{base:{lifecycle:number|null}}}[]}>(
    staff,'/staff/compare','POST',scene(category));
  const before=await compare();
  expect(before.demandCount).toBe(1);
  expect(before.options[0].estimates.base.lifecycle).toBeNull();
  expect((await staff('/staff/types/'+category,'PUT',{name:'Calisthenics ladder',active:true,version:initial.version})).status).toBe(400);
  await updateType(initial,{name:'Calisthenics ladder',description:'Generic equipment type'});
  await updateType(initial,{description:'Stale editor'},409);
  expect(await (await client()('/inventory')).json()).toContainEqual(expect.objectContaining({id:existing.id,category,
    categoryName:'Calisthenics ladder'}));
  expect((await history(a)).requests).toContainEqual(expect.objectContaining({id:recorded.id,category,categoryName:'Calisthenics ladder'}));
  const after=await compare();
  expect(after.demandCount).toBe(before.demandCount);
  expect(after.revision).toBeGreaterThan(before.revision);
  const brief=(revision:number,calculatedAt:string)=>staff('/staff/export','POST',{scenario:scene(category),revision,calculatedAt});
  expect((await brief(before.revision,before.calculatedAt)).status).toBe(409);
  expect(await (await brief(after.revision,after.calculatedAt)).text()).toContain('Equipment: Calisthenics ladder');
  const confirmDate=(await history(a)).requests.find(item=>item.id===recorded.id)?.confirmedAt;
  await updateType(await getType(category),{active:false});
  expect(await (await client()('/catalog')).json()).not.toContainEqual(expect.objectContaining({id:category}));
  expect(await (await client()('/inventory')).json()).toContainEqual(expect.objectContaining({id:existing.id,condition:'usable',categoryActive:false}));
  expect((await client()('/inventory?category='+category)).status).toBe(409);
  expect((await staff('/staff/compare','POST',scene(category))).status).toBe(409);
  expect((await b('/resident/travel','POST',{category,query:'',origin:pilot.center,target:null,observations:{}})).status).toBe(409);
  expect((await b('/resident/requests','POST',{...request,category})).status).toBe(409);
  expect((await a('/resident/requests/'+recorded.id+'/reconfirm','POST',{})).status).toBe(409);
  expect((await staff('/staff/inventory/equipment','POST',{...equipment,category})).status).toBe(409);
  expect((await staff('/staff/inventory/candidates','POST',{...candidate,category})).status).toBe(409);
  const unrelated=await send(staff,'/staff/inventory/candidates/'+site.id,'PUT',{...candidate,category,notes:'Updated site note'});
  expect(unrelated).toEqual({id:site.id});
  expect((await staff('/staff/inventory/equipment/'+existing.id,'PUT',{...equipment,category,source:'Updated source'})).status).toBe(200);
  expect((await a('/resident/requests/'+recorded.id+'/withdraw','POST',{})).status).toBe(200);
  expect((await a('/resident/requests/'+recorded.id+'/restore','POST',{})).status).toBe(409);
  expect((await staff('/staff/types','POST',{name:' CALISTHENICS  LADDER '})).status).toBe(409);
  expect(await send(b,'/resident/proposal-name','POST',{name:' Calisthenics Ladder '})).toEqual({availability:'inactive'});
  expect((await b('/resident/proposals','POST',proposal('Calisthenics ladder'))).status).toBe(409);
  await updateType(await getType(category),{active:true});
  expect((await history(a)).requests.find(item=>item.id===recorded.id)).toMatchObject({confirmedAt:confirmDate,categoryActive:true});
  expect((await compare()).demandCount).toBe(0);
});

it('deduplicates normalized catalog names and rejects unauthorized or forged actions',async()=>{
  const conflict=await Promise.all([
    staff('/staff/types','POST',{name:'Équilibre rails'}),
    staff('/staff/types','POST',{name:' E\u0301QUILIBRE   RAILS '}),
  ]);
  expect(conflict.map(response=>response.status).sort()).toEqual([201,409]);
  expect((await staff('/staff/types','POST',{name:'Hidden\u0000Control'})).status).toBe(400);
  expect((await a('/staff/types','POST',{name:'Denied'})).status).toBe(403);
  expect((await a('/staff/proposals/'+crypto.randomUUID()+'/decision','POST',{action:'reject',reason:'Denied'})).status).toBe(403);
  expect((await client()('/resident/proposals','POST',proposal('Denied'))).status).toBe(401);
  expect((await a('/resident/proposals','POST',{...proposal('Forged type'),owner:aID,status:'approved'})).status).toBe(400);
  expect((await a('/resident/requests','POST',{...request,category:"' OR 1=1"})).status).toBe(400);
});

it('reviews independently, links duplicate intents to the untouched request and keeps private fields out of the queue',async()=>{
  const input=proposal('Jumping stpps');
  const submitted=await Promise.all([a('/resident/proposals','POST',input),a('/resident/proposals','POST',input)]);
  expect(submitted.map(response=>response.status).sort()).toEqual([200,201]);
  const [one,retry]=await Promise.all(submitted.map(response=>response.json() as Promise<{id:string}>));
  expect(one).toEqual(retry);
  expect((await a('/resident/proposals','POST',proposal(' JUMPING   STPPS '))).status).toBe(409);
  const second=await submit(b,'Jumping stpps');
  expect((await history(b)).proposals.map(row=>row.id)).toContain(second.id);
  expect((await history(b)).proposals.map(row=>row.id)).not.toContain(one.id);
  expect((await b('/resident/proposals/'+one.id+'/withdraw','POST',{})).status).toBe(404);
  const queue=await (await staff('/staff/proposals')).text();
  expect(queue).toContain('Jumping stpps');
  for(const value of ['Private request note','Separate proposed site','40.7202','resident-a@catalog.example',aID]) expect(queue).not.toContain(value);
  expect(await (await client()('/catalog')).text()).not.toContain('Jumping stpps');
  const before=(await history(a)).proposals.find(row=>row.id===one.id)!;

  const firstReview=await Promise.all([
    review(one.id,{action:'create',name:'Jumping steps'}),review(one.id,{action:'create',name:'Jumping steps'}),
  ]);
  expect(firstReview.map(response=>response.status).sort()).toEqual([200,409]);
  const after=await history(a);
  const resolved=after.proposals.find(row=>row.id===one.id)!;
  expect(resolved).toMatchObject({name:'Jumping stpps',status:'approved',categoryName:'Jumping steps',reusedRequest:false});
  const activated=after.requests.find(row=>row.id===resolved.requestId)!;
  expect(activated).toMatchObject({confirmedAt:before.submittedAt,note:input.note,point:input.point,suggestion:input.suggestion});
  expect(await send(a,'/resident/requests/'+activated.id,'GET',undefined)).toMatchObject({id:activated.id});
  expect((await b('/resident/requests/'+activated.id)).status).toBe(404);
  expect((await history(b)).proposals.find(row=>row.id===second.id)?.status).toBe('pending');
  const existing=await send<{id:string}>(b,'/resident/requests','POST',{...request,category:activated.category,note:'Original retained'},201);
  const prior=(await history(b)).requests.find(row=>row.id===existing.id);
  expect((await review(second.id,{action:'match',category:activated.category})).status).toBe(200);
  const other=await history(b);
  expect(other.proposals.find(row=>row.id===second.id)).toMatchObject({status:'approved',reusedRequest:true,requestId:existing.id});
  expect(other.requests.filter(row=>row.category===activated.category)).toEqual([prior]);
  expect((await send<{demandCount:number}>(staff,'/staff/compare','POST',scene(activated.category))).demandCount).toBe(2);

  const submittedAsNamed=await submit(a,'Échelle latérale');
  expect((await review(submittedAsNamed.id,{action:'create',name:'Échelle latérale'})).status).toBe(200);
  const rejected=await submit(a,'Ambiguous training apparatus');
  expect((await review(rejected.id,{action:'reject',reason:' '})).status).toBe(400);
  expect((await review(rejected.id,{action:'reject',reason:'Please specify the apparatus.'})).status).toBe(200);
  expect((await history(a)).proposals.find(row=>row.id===rejected.id)).toMatchObject({
    status:'rejected',reason:'Please specify the apparatus.',requestId:null,
  });
});

it('handles withdrawal, account removal, a competing normal request and atomic rollback',async()=>{
  const withdrawn=await submit(a,'Withdrawn equipment proposal');
  expect((await a('/resident/proposals/'+withdrawn.id+'/withdraw','POST',{})).status).toBe(200);
  expect((await review(withdrawn.id,{action:'create',name:'Never published'})).status).toBe(409);
  expect(await (await client()('/catalog')).text()).not.toContain('Never published');
  const erased=await account('erased');
  const removed=await submit(erased.call,'Erased equipment proposal');
  await db.prepare('DELETE FROM user WHERE id=?').bind(erased.id).run();
  expect((await review(removed.id,{action:'match',category:'pull-up'})).status).toBe(409);
  expect(await db.prepare('SELECT id FROM type_proposals WHERE id=?').bind(removed.id).first()).toBeNull();

  const race=await submit(b,'Parallel support rigs');
  const competing=await Promise.all([review(race.id,{action:'match',category:'parallel'}),
    b('/resident/requests','POST',{...request,category:'parallel',note:'Competing request'})]);
  expect(competing[0].status).toBe(200);
  expect([201,409]).toContain(competing[1].status);
  expect((await history(b)).requests.filter(row=>row.category==='parallel')).toHaveLength(1);

  const failure=await submit(b,'Unsupported fixture failure');
  await db.prepare("CREATE TRIGGER fail_catalog_demand BEFORE INSERT ON demand WHEN NEW.category NOT IN ('pull-up','parallel','sit-up') BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;").run();
  try {expect((await review(failure.id,{action:'create',name:'Atomic demo type'})).status).toBe(500);}
  finally {await db.prepare('DROP TRIGGER fail_catalog_demand').run();}
  expect(await (await client()('/catalog')).text()).not.toContain('Atomic demo type');
  expect((await history(b)).proposals.find(row=>row.id===failure.id)?.status).toBe('pending');
});

it('enforces pending and UTC-day limits and counts a duplicate retry once',async()=>{
  const {call,id}=await account('quota');
  const pending=Array.from({length:catalogLimits.pending+1},(_,index)=>proposal('Quota apparatus '+index));
  const submitted=await Promise.all(pending.map(value=>call('/resident/proposals','POST',value)));
  expect(submitted.filter(response=>response.status===201)).toHaveLength(catalogLimits.pending);
  expect(submitted.filter(response=>response.status===429)).toHaveLength(1);
  const historyBefore=(await history(call)).proposals;
  for(const row of historyBefore) expect((await call('/resident/proposals/'+row.id+'/withdraw','POST',{})).status).toBe(200);
  for(let index=catalogLimits.pending;index<catalogLimits.daily;index++) {
    const next=await submit(call,'Extra quota type '+index);
    expect((await call('/resident/proposals/'+next.id+'/withdraw','POST',{})).ok).toBe(true);
  }
  const successfulIndex=submitted.findIndex(response=>response.status===201);
  expect((await call('/resident/proposals','POST',pending[successfulIndex])).status).toBe(200);
  expect((await call('/resident/proposals','POST',proposal('One too many'))).status).toBe(429);
  await db.prepare('UPDATE type_proposals SET submitted_at=? WHERE owner=?').bind('2020-01-01T00:00:00.000Z',id).run();
  await submit(call,'New UTC day allowance');
});
