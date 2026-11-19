import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {ai,planning} from '../config/settings';
import type {Scenario} from '../src/contracts';
import {cachedExplanation,explain,explanationCacheKey,explanationRequest} from '../src/server/ai';
import {getComparison,stmt} from '../src/server/database';
import type {Env} from '../src/server/web';
import type {Comparison} from '../src/server/planning';
import {database} from './database';

const scenario:Scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
const output={summary:'No option qualifies for a highlight in this comparison.',tradeoffs:'',checks:'',
  referencedOptionIds:[]};
const explanation={...output,highlightedOptionIds:[]};
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
  env={DB:db,AI_ENABLED:'true',OPENAI_MODEL:'gpt-6-luna',OPENAI_REASONING_EFFORT:'low',OPENAI_API_KEY:'mock-only',
    APP_ORIGIN:'http://127.0.0.1:8787',AUTH_SECRET:'synthetic test configuration secret',
    ASSETS:{fetch:()=>Promise.resolve(new Response('test assets')),connect:()=>{throw new Error('Unused');}} as Fetcher};
  await db.prepare(`INSERT INTO synthetic_demand VALUES('known-only-to-server','pull-up',40.7192,-73.8461)`).run();
  result=await current();
});
afterAll(async()=>await proxy?.dispose());
async function current() {
  const value=await getComparison(db,scenario);
  if(!value||typeof value==='string')throw new Error('No test comparison.');
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
    const {input}=JSON.parse(body);
    expect(input[0]).toMatchObject({role:'developer',content:expect.stringContaining(`${ai.outputWords} words`)});
    expect(input[1]).toMatchObject({role:'user'});
    expect(JSON.parse(input[1].content)).toMatchObject({scenario:{area:'Brooklyn and Queens',distance:'straight-line approximation',horizonYears:10},
      demand:{eligibleUniqueActiveRequesters:1,alreadyServed:0,baselineUnmet:1},costs:{currency:'USD',internalUnit:'cents'}});
    if(String(url).endsWith('/input_tokens')) {
      calls.push('count');
      return Response.json({input_tokens:tokens});
    }
    calls.push('generation');
    expect(JSON.parse(body)).toMatchObject({max_output_tokens:ai.outputTokens,store:false,service_tier:'default',model:'gpt-6-luna',reasoning:{effort:'low'}});
    await hold?.();
    if(failure)throw new Error('Test timeout');
    return Response.json(response);
  })};
}
const spent=()=>db.prepare('SELECT spent FROM ai_total WHERE id=1').first<number>('spent');

it('checks tokens and caches a bounded aggregate without generating twice',async()=>{
  const fake=provider();
  expect(await explain(env,result,fake.fetch)).toEqual(explanation);
  expect(await explain(env,result,fake.fetch)).toEqual(explanation);
  expect(await cachedExplanation(env,result)).toEqual(explanation);
  expect(fake.calls).toEqual(['count','generation']);
  const newRevision=await revise();
  expect(await cachedExplanation(env,newRevision)).toBeUndefined();
  const oversized=provider({tokens:ai.inputTokens+1});
  await expect(explain(env,newRevision,oversized.fetch)).rejects.toMatchObject({status:400});
  expect(oversized.calls).toEqual(['count']);
  await expect(explain({...env,AI_ENABLED:'false'},newRevision,fake.fetch)).rejects.toMatchObject({status:503});
});

it('blocks duplicate work and allows distinct requests from the same account after five seconds',async()=>{
  const comparison=await revise();
  const start=Promise.withResolvers<void>();
  const release=Promise.withResolvers<void>();
  const first=provider({failure:true});
  const heldProvider:typeof fetch=async(url,options)=>{
    if(String(url).endsWith('/input_tokens')) {
      start.resolve();
      await release.promise;
    }
    return first.fetch(url,options);
  };
  const scope={staffScope:'same-test-account'};
  const pending=explain(env,comparison,heldProvider,undefined,scope);
  const check=expect(pending).rejects.toMatchObject({status:502});
  await start.promise;
  const other=provider();
  try {
    await expect(explain(env,comparison,other.fetch,undefined,scope)).rejects.toMatchObject({status:409});
    const next=await revise();
    await expect(explain(env,next,other.fetch,undefined,scope)).rejects.toMatchObject({status:429});
    expect(other.calls).toEqual([]);
    await stmt(db,'UPDATE ai_staff_usage SET started=started-? WHERE scope=?',ai.cooldownMs.staff,scope.staffScope).run();
    expect(await explain(env,next,other.fetch,undefined,scope)).toEqual(explanation);
    expect(other.calls).toEqual(['count','generation']);
  } finally {release.resolve();}
  await check;
});

it('ignores legacy limits, rejects invalid output and refuses an explanation for stale data',async()=>{
  const today=new Date().toISOString().slice(0,10);
  await db.batch([
    stmt(db,'UPDATE ai_total SET spent=1000000000000 WHERE id=1'),
    stmt(db,'INSERT INTO ai_day(day,attempts) VALUES (?,1000)',today),
  ]);
  expect(await explain(env,await revise(),provider().fetch)).toEqual(explanation);
  expect(await spent()).toBe(1000000000000);
  expect(await stmt(db,'SELECT attempts FROM ai_day WHERE day=?',today).first('attempts')).toBe(1000);
  const bad=provider({response:{...success,output:[{content:[{type:'output_text',text:'bad JSON'}]}]}});
  const comparison=await revise();
  await expect(explain(env,comparison,bad.fetch)).rejects.toMatchObject({status:502});
  expect(await cachedExplanation(env,comparison)).toBeUndefined();
  const stale=provider({hold:async()=>{await revise();}});
  await expect(explain(env,await revise(),stale.fetch)).rejects.toMatchObject({status:409});
  expect(testRevision).toBeGreaterThan(2);
});

it('keys explanations on rendered instructions, snapshot, model, schema and generation settings',async()=>{
  const request=explanationRequest(env,result);
  const key=await explanationCacheKey(result.revision,request);
  expect(await explanationCacheKey(result.revision,explanationRequest(env,{...result,calculatedAt:new Date().toISOString()}))).toBe(key);
  const alternatives=[
    {...request,payload:{...request.payload,input:[{...request.payload.input[0],content:'Changed prompt'},request.payload.input[1]]}},
    explanationRequest(env,{...result,scenario:{...scenario,radius:scenario.radius+10}}),
    explanationRequest({...env,OPENAI_MODEL:'another-model'},result),
    {...request,generation:{...request.generation,max_output_tokens:ai.outputTokens-1}},
  ];
  for(const changed of alternatives) expect(await explanationCacheKey(result.revision,changed)).not.toBe(key);
  expect(await explanationCacheKey(result.revision,request,999)).not.toBe(key);
});

it('rejects invalid snapshot before a call, validates output IDs and bounds, and allows manual retry',async()=>{
  const comparison=await revise();
  const fake=provider();
  await expect(explain(env,{...comparison,unmet:5},fake.fetch)).rejects.toMatchObject({status:503});
  expect(fake.calls).toEqual([]);
  const overrun=provider({response:{...success,usage:{...success.usage,output_tokens:ai.outputTokens+1}}});
  await expect(explain(env,comparison,overrun.fetch)).rejects.toThrow('exceeded the configured token bounds');
  expect(await cachedExplanation(env,comparison)).toBeUndefined();
  for(const invalid of [{...output,referencedOptionIds:['unlisted']},{...output,highlightedOptionIds:['unlisted']},
    {...output,summary:'word '.repeat(ai.outputWords+1)}]) {
    const bad=provider({response:{...success,output:[{content:[{type:'output_text',text:JSON.stringify(invalid)}]}]}});
    await expect(explain(env,{...comparison},bad.fetch)).rejects.toMatchObject({status:502});
    expect(await cachedExplanation(env,comparison)).toBeUndefined();
  }
  expect(await explain(env,comparison,fake.fetch)).toEqual(explanation);
});

it('distinguishes incomplete and refused responses and logs only safe reason codes',async()=>{
  const comparison=await revise();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    const incomplete=provider({response:{...success,status:'incomplete'}});
    await expect(explain(env,comparison,incomplete.fetch,'test-request')).rejects.toThrow('did not finish');
    const refused=provider({response:{...success,output:[{content:[{type:'refusal',refusal:'private fixture'}]}]}});
    await expect(explain(env,comparison,refused.fetch,'test-request')).rejects.toThrow('declined');
    expect(warn.mock.calls.map(([entry])=>JSON.parse(entry))).toEqual([
      {level:'warn',operation:'ai_explanation_rejected',requestId:'test-request',reason:'response_incomplete'},
      {level:'warn',operation:'ai_explanation_rejected',requestId:'test-request',reason:'provider_refusal'},
    ]);
    expect(await cachedExplanation(env,comparison)).toBeUndefined();
  } finally {warn.mockRestore();}
});
