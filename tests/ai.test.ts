import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {ai,planning} from '../config/settings';
import type {Scenario} from '../src/contracts';
import {cachedExplanation,explain} from '../src/server/ai';
import {getComparison,stmt} from '../src/server/database';
import type {Env} from '../src/server/web';
import type {Comparison} from '../src/server/planning';
import {database} from './database';

const scenario:Scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
const output={summary:'Illustrative comparison',tradeoffs:'Coverage overlaps',missing:'Unknown inputs',limitations:'Participation only'};
const success={status:'completed',usage:{input_tokens:500,output_tokens:100},
  output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]};
let proxy:Awaited<ReturnType<typeof database>>;
let env:Env;
let result:Comparison;
let testRevision=0;
let db:D1Database;
beforeAll(async()=>{
  proxy=await database();
  db=proxy.env.DB;
  env={DB:db,AI_ENABLED:'true',OPENAI_API_KEY:'mock-only',AI_BUDGET_MICROUSD:'10000',
    AI_INPUT_MICROUSD_PER_MILLION:'1000000',AI_OUTPUT_MICROUSD_PER_MILLION:'2000000',
    APP_ORIGIN:'http://127.0.0.1:8787',AUTH_SECRET:'synthetic test configuration secret',
    ASSETS:{fetch:()=>Promise.resolve(new Response('test assets')),connect:()=>{throw new Error('Unused');}} as Fetcher};
  await db.prepare('UPDATE operations SET ai_frozen=0 WHERE id=1').run();
  await db.prepare(`INSERT INTO synthetic_demand VALUES('known-only-to-server','pull-up',40.7192,-73.8461)`).run();
  result=await current();
});
afterAll(async()=>await proxy?.dispose());
async function current() {
  const value=await getComparison(db,scenario);
  if(!value||value==='limit')throw new Error('No test comparison.');
  return value;
}
async function revise() {
  await db.prepare('UPDATE revision SET value=value+1 WHERE id=1').run();
  testRevision++;
  return current();
}
function provider({tokens=500,response=success,hold,failure=false}:{tokens?:number;response?:object;hold?:()=>Promise<void>;failure?:boolean}={}) {
  const calls:string[]=[];
  return {calls,fetch:vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const body=String(init?.body);
    expect(body).not.toContain('40.7192');
    expect(body).not.toContain('known-only-to-server');
    expect(body).not.toContain('mock-only');
    if(String(url).endsWith('/input_tokens')) {
      calls.push('count');
      return Response.json({input_tokens:tokens});
    }
    calls.push('generation');
    expect(JSON.parse(body)).toMatchObject({max_output_tokens:1000,store:false,service_tier:'default',reasoning:{effort:'none'}});
    await hold?.();
    if(failure)throw new Error('Test timeout');
    return Response.json(response);
  })};
}
const spent=()=>db.prepare('SELECT spent FROM ai_total WHERE id=1').first<number>('spent');

it('checks tokens and caches a bounded aggregate without spending twice',async()=>{
  const fake=provider();
  expect(await explain(env,result,fake.fetch)).toEqual(output);
  expect(await explain(env,result,fake.fetch)).toEqual(output);
  expect(await cachedExplanation(env,result)).toEqual(output);
  expect(fake.calls).toEqual(['count','generation']);
  expect(await spent()).toBe(700);
  const newRevision=await revise();
  expect(await cachedExplanation(env,newRevision)).toBeUndefined();
  const oversized=provider({tokens:ai.inputTokens+1});
  await expect(explain(env,newRevision,oversized.fetch)).rejects.toMatchObject({status:400});
  expect(oversized.calls).toEqual(['count']);
  await expect(explain({...env,AI_ENABLED:'false'},newRevision,fake.fetch)).rejects.toMatchObject({status:503});
});

it('serializes duplicate and distinct concurrent spending and retains uncertain reservations',async()=>{
  const comparison=await revise();
  const start=Promise.withResolvers<void>();
  const release=Promise.withResolvers<void>();
  const first=provider({hold:()=>{start.resolve();return release.promise;},failure:true});
  const pending=explain({...env,AI_BUDGET_MICROUSD:'4700'},comparison,first.fetch);
  const check=expect(pending).rejects.toMatchObject({status:502});
  await start.promise;
  const duplicate=provider();
  await expect(explain(env,comparison,duplicate.fetch)).rejects.toMatchObject({status:409});
  const different=await revise();
  await expect(explain({...env,AI_BUDGET_MICROUSD:'4700'},different,duplicate.fetch)).rejects.toMatchObject({status:429});
  expect(duplicate.calls).not.toContain('generation');
  release.resolve();
  await check;
  expect(await spent()).toBe(4700);
});

it('enforces the UTC cap, rejects invalid output and refuses an explanation for stale data',async()=>{
  const today=new Date().toISOString().slice(0,10);
  await stmt(db,'UPDATE ai_day SET attempts=? WHERE day=?',ai.daily,today).run();
  const fake=provider();
  await expect(explain(env,await revise(),fake.fetch)).rejects.toMatchObject({status:429});
  expect(fake.calls).toEqual(['count']);
  await stmt(db,'UPDATE ai_day SET attempts=? WHERE day=?',ai.daily-2,today).run();
  const bad=provider({response:{...success,output:[{content:[{type:'output_text',text:'bad JSON'}]}]}});
  const comparison=await revise();
  await expect(explain(env,comparison,bad.fetch)).rejects.toMatchObject({status:502});
  expect(await cachedExplanation(env,comparison)).toBeUndefined();
  const stale=provider({hold:async()=>{await revise();}});
  await expect(explain(env,await revise(),stale.fetch)).rejects.toMatchObject({status:409});
  expect(await spent()).toBe(6100);
  expect(testRevision).toBeGreaterThan(2);
});
