import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { ai } from '../config/settings';
import { travel } from '../config/travel';
import { createAuth } from '../src/server/auth';
import app from '../src/server/index';
import type { TravelResponse } from '../src/travel';
import type { Env } from '../src/server/web';
import { database } from './database';

const origin='http://127.0.0.1:8787';
const point={lat:40.72,lng:-73.847};
const password='long synthetic test passphrase';
const input={category:'pull-up',query:'Travel fixture',origin:point,target:null,observations:{}};
let proxy:Awaited<ReturnType<typeof database>>,env:Env;
let first:string,second:string,staff:string,automated:string;
const calls:{kind:string;body:Record<string,unknown>}[]=[];
let reason='distance',replaceId='', fail=false;
let hold: {entered:PromiseWithResolvers<void>;release:PromiseWithResolvers<void>}|undefined;

async function account(name:string,role:'staff'|'resident') {
  const auth=createAuth(env);
  const email=`${name}@blockfit.example`;
  const {user}=await auth.api.createUser({body:{email,name,password,role}});
  if(name==='automated') await env.DB.prepare("UPDATE user SET purpose='automated-test' WHERE id=?").bind(user.id).run();
  const response=await auth.api.signInEmail({body:{email,password},headers:new Headers({Origin:origin}),asResponse:true});
  return response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
}

const request=(cookie:string,body:object)=>app.request(origin+'/api/resident/travel',{method:'POST',
  headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)},env);

beforeAll(async()=>{
  proxy=await database();
  env={DB:proxy.env.DB,APP_ORIGIN:origin,AUTH_SECRET:crypto.randomUUID(),DEPLOYMENT:'local',AI_ENABLED:'true',
    OPENAI_MODEL:'gpt-6-luna',OPENAI_REASONING_EFFORT:'low',OPENAI_API_KEY:'mock-test-value',
    ASSETS:{fetch:()=>Promise.resolve(new Response('test assets')),connect:()=>{throw new Error('Unused');}} as Fetcher};
  [first,second,staff,automated]=await Promise.all([
    account('first','resident'),account('second','resident'),account('staff','staff'),account('automated','resident'),
  ]);
  const good=(id:string,lat:number,condition='usable',access='public',archived=0)=>env.DB.prepare(
    `INSERT INTO equipment(id,name,category,lat,lng,condition,access,source,verified_on,visible,archived)
      VALUES(?,?,'pull-up',?,?,?,?,'Fixture','2026-01-01',1,?)`,
  ).bind(id,`Travel fixture ${id}`,lat,point.lng,condition,access,archived);
  await env.DB.batch([
    ...Array.from({length:travel.pageSize+1},(_,index)=>good(`a-${String(index).padStart(3,'0')}`,point.lat+.002)),
    good('z-last',point.lat),good('unusable',point.lat,'unusable'),good('unknown',point.lat,'unknown'),
    good('private',point.lat,'usable','restricted'),good('archived',point.lat,'usable','public',1)]);
  const real=globalThis.fetch;
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(!String(input).startsWith('https://api.openai.com/v1/responses')) return real(input,init);
    const body=JSON.parse(String(init?.body));
    const counting=String(input).endsWith('/input_tokens');
    calls.push({kind:counting?'count':'generate',body});
    if(counting) return Response.json({input_tokens:500});
    if(hold) {hold.entered.resolve();await hold.release.promise;}
    if(fail) throw Error('mock provider timeout');
    const snapshot=JSON.parse(body.input[1].content);
    return Response.json({status:'completed',usage:{input_tokens:500,output_tokens:100},output:[{content:[{
      type:'output_text',text:JSON.stringify({options:snapshot.recommendationIds.map((id:string)=>({id:replaceId||id,reason}))}),
    }]}]});
  });
});
afterAll(async()=>{vi.unstubAllGlobals();await proxy?.dispose();});

it('blocks anonymous, staff, and automated-test accounts and returns empty without provider calls',async()=>{
  expect((await request('',input)).status).toBe(401);
  expect((await request(staff,input)).status).toBe(403);
  expect((await request(automated,input)).status).toBe(403);
  expect(await (await request(first,{...input,category:'parallel'})).json()).toMatchObject({options:[]});
  expect(calls).toEqual([]);
});

it('selects nearest across pages, keeps scoped caches and shares cooldown across modes',async()=>{
  expect(ai.cooldownMs.resident).toBe(5_000);
  const response=await request(first,input);
  expect(response.status).toBe(200);
  const data=await response.json() as TravelResponse;
  expect(data.options.map(option=>option.id)).toEqual(['z-last','a-000','a-001']);
  const payload=JSON.stringify(calls[0].body);
  expect(payload).not.toContain(String(point.lat));
  expect(payload).not.toContain(String(point.lng));
  expect(payload).not.toContain('first@blockfit.example');
  expect(await (await request(first,input)).json()).toMatchObject({cached:true});
  expect(calls).toHaveLength(2);
  expect((await request(first,{...input,target:'a-090'})).status).toBe(429);
  const direct=await request(second,{...input,target:'a-090'});
  expect(await direct.json()).toMatchObject({cached:false,options:[{id:'a-090',reason:'distance'}]});
  expect((await request(second,input)).status).toBe(429);
  expect(calls).toHaveLength(4);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM ai_resident_usage').first('n')).toBe(2);
});

it('validates mapped claims, cache invalidation, and ignores legacy resident attempt counts',async()=>{
  await env.DB.prepare('UPDATE ai_resident_usage SET started=?').bind(Date.now()-ai.cooldownMs.resident*2).run();
  const stop={...point,mode:'rail',name:'Mapped station'};
  const evidence={origin:[stop],'z-last':[stop]};
  reason='mapped-rail';
  const good=await request(first,{...input,target:'z-last',observations:evidence});
  expect(await good.json()).toMatchObject({cached:false,evidence:'partial',options:[{id:'z-last',reason:'mapped-rail'}]});
  expect(await (await request(first,{...input,target:'z-last',observations:evidence})).json()).toMatchObject({cached:true});
  expect((await request(first,{...input,target:'z-last',observations:{origin:[stop]}})).status).toBe(429);
  await env.DB.prepare('UPDATE ai_resident_usage SET started=?').bind(Date.now()-ai.cooldownMs.resident*2).run();
  expect((await request(first,{...input,target:'z-last',observations:{origin:[stop]}})).status).toBe(502);
  reason='distance';
  replaceId='unusable';
  await env.DB.prepare('UPDATE ai_resident_usage SET started=?').bind(Date.now()-ai.cooldownMs.resident*2).run();
  expect((await request(first,{...input,target:'z-last',observations:{origin:[stop]}})).status).toBe(502);
  replaceId='';
  await env.DB.prepare('UPDATE ai_resident_usage SET started=?,attempts=50').bind(Date.now()-ai.cooldownMs.resident*2).run();
  await env.DB.prepare("INSERT INTO throttle(key,window,attempts) SELECT 'travel:'||scope,?,100 FROM ai_resident_usage")
    .bind(Math.floor(Date.now()/600_000)).run();
  expect((await request(first,{...input,target:'a-007'})).status).toBe(200);
  expect(await (await request(first,input)).json()).toMatchObject({cached:true});
  expect(await env.DB.prepare('SELECT attempts FROM ai_resident_usage WHERE attempts=50 LIMIT 1').first('attempts')).toBe(50);
});

it('blocks duplicates and allows retries after the cooldown when the provider fails',async()=>{
  await env.DB.prepare('UPDATE ai_resident_usage SET started=?').bind(Date.now()-ai.cooldownMs.resident*2).run();
  hold={entered:Promise.withResolvers(),release:Promise.withResolvers()};
  fail=true;
  const pending=request(first,{...input,target:'a-008'});
  await hold.entered.promise;
  try {
    const duplicate=await request(first,{...input,target:'a-008'});
    expect(duplicate.status).toBe(409);
    expect((await request(first,{...input,target:'a-009'})).status).toBe(429);
  } finally {hold.release.resolve();}
  expect((await pending).status).toBe(502);
  hold=undefined;fail=false;
  expect((await request(first,{...input,target:'a-008'})).status).toBe(429);
  await env.DB.prepare('UPDATE ai_resident_usage SET started=started-?').bind(ai.cooldownMs.resident).run();
  expect((await request(first,{...input,target:'a-008'})).status).toBe(200);
});
