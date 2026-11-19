import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { goalLimits, structuredGoalDescription } from '../config/goals';
import { ai, pilot, planning } from '../config/settings';
import type { Candidate, Scenario } from '../src/contracts';
import { goalRows, goalView, type Goal, type GoalInput } from '../src/goals';
import { createAuth } from '../src/server/auth';
import { parseGoalEvaluation } from '../src/server/goal-evaluation';
import app from '../src/server/index';
import { compare, type Comparison } from '../src/server/planning';
import type { Env } from '../src/server/web';
import { database } from './database';

const amount={low:100,base:100,high:100};
const costs={equipment:amount,installation:amount,preparation:amount,accessibility:amount,maintenance:amount,
  replacement:null,interval:null,replacementPlan:'none' as const,source:'Illustrative estimate'};
const candidate=(id:string,extra:Partial<Candidate>={}):Candidate=>({...pilot.center,id,name:id,category:'pull-up',
  categoryName:'Pull-up bars',categoryActive:true,parkId:null,feasibility:'suitable-for-comparison',costs,notes:'',projectUrl:null,...extra});
const scene:Scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
const dateGoal:GoalInput={name:'Low disruption',description:'Favor straightforward installation with evidence of limited ground disturbance.',
  earliestStart:'2027-03-01',targetCompletion:'2027-05-01',allowedTypes:['pull-up']};
const good={estimatedStart:'2027-03-01',estimatedReady:'2027-05-01'};
const password='synthetic goals passphrase';
const origin='http://127.0.0.1:8787';
let proxy:Awaited<ReturnType<typeof database>>;
let db:D1Database;
let env:Env;
let staff:ReturnType<typeof client>;
let second:ReturnType<typeof client>;
let resident:ReturnType<typeof client>;

function client(cookie='') {
  return (path:string,method='GET',data?:unknown)=>app.request(origin+'/api'+path,{method,headers:{
    Origin:origin,...cookie&&{Cookie:cookie},...data!==undefined&&{'Content-Type':'application/json'},
  },body:data===undefined?undefined:JSON.stringify(data)},env);
}
async function actor(key:string,role:'staff'|'resident') {
  const auth=createAuth(env),email=key+'@goals.example';
  await auth.api.createUser({body:{email,password,name:key,role}});
  const response=await auth.api.signInEmail({body:{email,password},headers:new Headers({Origin:origin}),asResponse:true});
  return client(response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; '));
}
async function send<T>(call:ReturnType<typeof client>,path:string,method='GET',data?:unknown,status=200) {
  const response=await call(path,method,data);
  expect(response.status,await response.clone().text()).toBe(status);
  return await response.json() as T;
}
const list=()=>send<Goal[]>(staff,'/staff/goals');
const makeGoal=(value:GoalInput)=>send<{id:string;version:number}>(staff,'/staff/goals','POST',value,201);
async function reference(scenario=scene) {
  const result=await send<Comparison>(staff,'/staff/compare','POST',scenario);
  return {scenario,revision:result.revision,calculatedAt:result.calculatedAt};
}
const candidateBody=(name:string,extra:object={})=>({...pilot.center,name,category:'pull-up',parkId:null,feasibility:'suitable-for-comparison',
  notes:'Synthetic staff note about surface-mounted installation',projectUrl:null,costs,...extra});
const addCandidate=(name:string,extra:object={})=>send<{id:string}>(staff,'/staff/inventory/candidates','POST',candidateBody(name,extra),201);

beforeAll(async()=>{
  proxy=await database();db=proxy.env.DB;
  env={DB:db,APP_ORIGIN:origin,AUTH_SECRET:'synthetic test goals configuration secret',
    ASSETS:{fetch:async()=>new Response('test assets'),connect:()=>{throw new Error('Unused');}},
    AI_ENABLED:'true',OPENAI_API_KEY:'mock-only',OPENAI_MODEL:'gpt-6.2-sol',OPENAI_REASONING_EFFORT:'low',
    AI_BUDGET_MICROUSD:'50000000',AI_INPUT_MICROUSD_PER_MILLION:'1000000',AI_OUTPUT_MICROUSD_PER_MILLION:'2000000',
  };
  await db.prepare('UPDATE operations SET ai_frozen=0 WHERE id=1').run();
  staff=await actor('staff','staff');second=await actor('second','staff');resident=await actor('resident','resident');
});
afterAll(async()=>await proxy?.dispose());

it('keeps goal requirements, hard eligibility and AI fit separate with inclusive dates and union coverage',()=>{
  const sites=[
    candidate('a',good),candidate('b',{estimatedStart:'2027-02-28'}),
    candidate('c',{...good,costs:{...costs,maintenance:null}}),candidate('d',good),
    candidate('e',{...good,feasibility:'excluded'}),candidate('f',good),
  ];
  const scenario={...scene,selected:['a','b']};
  const result={scenario,sites,...compare(scenario,[{id:'synthetic',...pilot.center,synthetic:true}],[],sites)!};
  const rows=goalRows(result,dateGoal,{clarification:null,assessments:['b','d','e','a','c'].map(id=>({
    id,fit:id==='d'?'weak':'strong',reason:'Observed evidence',evidence:['checks'],missing:[],conflict:null,
  }))});
  expect(result.options.at(-1)).toMatchObject({count:1,overlap:1});
  expect(rows.find(row=>row.id==='a,b')).toMatchObject({requirement:'fails',bucket:'excluded',
    requirements:[{code:'early',site:'b'},{code:'ready',site:'b'}]});
  expect(rows.find(row=>row.id==='b')).toMatchObject({fit:'strong',bucket:'excluded'});
  expect(rows.find(row=>row.id==='c')).toMatchObject({fit:'strong',bucket:'information'});
  expect(rows.find(row=>row.id==='e')).toMatchObject({fit:'strong',bucket:'excluded'});
  expect(goalRows(result,{...dateGoal,earliestStart:null,targetCompletion:null})[1].requirement).toBe('meets');
  const view=goalView(rows,'all','fit');
  expect(view.visible.map(row=>row.id)).toEqual(['a','d','f','c','b','e','a,b']);
  expect(view.counts).toEqual({match:1,excluded:3,information:1,pending:1,weak:1});
  expect(goalView(rows,'strong','fit')).toMatchObject({shown:1,hidden:6,visible:[{id:'a'}]});
  expect(goalView(rows,'excluded','baseline').visible.map(row=>row.id)).toEqual(['b','e','a,b']);
});

it('accepts explicit clarification and rejects omitted options, unsafe shapes and nonexistent evidence',()=>{
  const expected=new Map([['a',new Set(['s1'])],['b',new Set(['s1'])]]);
  const row={id:'a',fit:'strong',reason:'The site notes describe installation on an existing pad.',evidence:['s1'],missing:[],conflict:null};
  const parse=(assessments:unknown[],clarification:string|null=null)=>parseGoalEvaluation(JSON.stringify({clarification,assessments}),expected);
  expect(parse([],'Which outcome matters most?').explanation).toMatchObject({assessments:[]});
  expect(parse([row,{...row,id:'b',fit:'insufficient',evidence:[],missing:['Youth participation data']}]).explanation?.assessments).toHaveLength(2);
  for(const bad of [
    [row], [row,row], [row,{...row,id:'c'}], [row,{...row,id:'b',fit:'100%'}],
    [row,{...row,id:'b',evidence:['invented-measurement']}],
    [row,{...row,id:'b',reason:'word '.repeat(goalLimits.reasonWords+1).trim()}],
    [row,{...row,id:'b',reason:'word'.repeat(100)}],
    [row,{...row,id:'b',missing:['one','two','three','four']}],
  ])expect(parse(bad).reason).toBeDefined();
  expect(parse([row], 'Which outcome matters most?').reason).toBeDefined();
});

it('validates shared goal CRUD and preserves a renamed or inactive catalog restriction',async()=>{
  expect((await client()('/staff/goals')).status).toBe(401);
  expect((await resident('/staff/goals')).status).toBe(403);
  expect((await resident('/staff/goals/evaluate','POST',{})).status).toBe(403);
  for(const invalid of [{name:''},{name:'x'.repeat(goalLimits.name+1)},{description:'x'.repeat(goalLimits.description+1)},
    {targetCompletion:'2027-02-28'},{targetCompletion:'2027-02-30'},{allowedTypes:['missing-id']},{allowedTypes:['pull-up','pull-up']}]) {
    expect([400,409]).toContain((await staff('/staff/goals','POST',{...dateGoal,...invalid})).status);
  }
  const created=await makeGoal({...dateGoal,name:'  Public readiness  ',allowedTypes:['parallel']});
  await db.prepare("UPDATE equipment_types SET name='Parallel practice bars',active=0 WHERE id='parallel'").run();
  const item=(await list()).find(goal=>goal.id===created.id);
  expect(item).toMatchObject({name:'Public readiness',earliestStart:'2027-03-01',targetCompletion:'2027-05-01',
    allowedTypes:['parallel'],types:[{id:'parallel',name:'Parallel practice bars',active:false}]});
  const stale=await Promise.all([staff('/staff/goals/'+created.id,'PUT',{...dateGoal,name:'First',allowedTypes:['parallel'],version:1}),
    second('/staff/goals/'+created.id,'PUT',{...dateGoal,name:'Second',allowedTypes:['parallel'],version:1})]);
  expect(stale.map(response=>response.status).sort()).toEqual([200,409]);
  expect((await staff('/staff/goals/'+created.id,'DELETE',{version:1})).status).toBe(409);
  expect((await second('/staff/goals/'+created.id,'DELETE',{version:2})).status).toBe(200);
  expect((await list()).some(goal=>goal.id===created.id)).toBe(false);
});

it('bounds spend, reuses one authoritative assessment, and gives Explain and export the selected goal view',async()=>{
  expect((await staff('/staff/inventory/candidates','POST',candidateBody('Invalid order',
    {estimatedStart:'2027-05-02',estimatedReady:'2027-05-01'}))).status).toBe(400);
  const first=await addCandidate('Surface-mounted court',good);
  const unknown=await addCandidate('Confirmed staging with missing schedule',{estimatedStart:'',estimatedReady:'',
    notes:'Staging slot confirmed. Utility review signed off.'});
  const goal=await makeGoal(dateGoal);
  const delivery={...dateGoal,name:'Delivery readiness',description:'Prioritize confirmed staging and utility clearance.',
    earliestStart:null,targetCompletion:null,allowedTypes:[]};
  const deliveryGoal=await makeGoal(delivery);
  const structured=await makeGoal({...dateGoal,description:structuredGoalDescription});
  const ref=await reference();
  const calls:string[]=[];
  const assessmentGoals:unknown[]=[];
  let lastExplanation:{goalReview?:unknown}|undefined;
  const realFetch=fetch;
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(!url.startsWith('https://api.openai.com/'))return realFetch(input,init);
    const payload=JSON.parse(String(init?.body));
    const snapshot=JSON.parse(payload.input[1].content);
    const assessment=payload.text.format.name==='program_goal_assessment';
    calls.push(`${assessment?'evaluate':'explain'}:${url.endsWith('input_tokens')?'count':'generate'}`);
    expect(JSON.stringify(snapshot)).not.toContain('resident@goals.example');
    expect(JSON.stringify(snapshot)).not.toContain(String(pilot.center.lat));
    expect(JSON.stringify(snapshot)).not.toContain('requestDate');
    if(url.endsWith('input_tokens'))return Response.json({input_tokens:900});
    if(!assessment)lastExplanation=snapshot;
    else assessmentGoals.push(snapshot.goal);
    const delivering=snapshot.goal?.id===deliveryGoal.id;
    const preferred=delivering?unknown.id:first.id;
    const value=assessment?{clarification:null,assessments:snapshot.options.map(({id}: {id:string})=>({
      id,fit:id===preferred?'strong':'insufficient',reason:delivering?
        (id===preferred?(snapshot.goal.version===2?'The revised goal prioritizes utility review.':'The staging slot is confirmed.'):'Staging confirmation is missing.'):
        (id===preferred?'The supplied site notes describe a surface-mounted installation.':'Delivery evidence is missing.'),
      evidence:['s1'],missing:id===preferred?[]:['Delivery readiness'],conflict:null,
    }))}:{summary:'Low disruption favors the documented surface-mounted court. Options with unknown schedules stay outside the fit filter.',
      tradeoffs:'Review modeled costs and recorded demand.',checks:'Confirm delivery details.',referencedOptionIds:[first.id]};
    return Response.json({status:'completed',usage:{input_tokens:900,output_tokens:150},
      output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]});
  });
  try {
    expect(await send(staff,'/staff/goals/preview','POST',{...ref,goal})).toMatchObject({evaluation:null});
    expect(await send(staff,'/staff/goals/evaluate','POST',{...ref,goal:structured})).toMatchObject({blocked:expect.stringContaining('No AI evaluation')});
    expect(calls).toHaveLength(0);
    const evaluated=await send<{evaluationKey:string}>(staff,'/staff/goals/evaluate','POST',{...ref,goal});
    expect(evaluated).toMatchObject({evaluation:{assessments:expect.arrayContaining([{id:first.id,fit:'strong',reason:expect.any(String),
      evidence:['s1'],missing:[],conflict:null}])}});
    expect(await send(second,'/staff/goals/preview','POST',{...ref,goal})).toMatchObject({evaluationKey:evaluated.evaluationKey});
    expect(await send(staff,'/staff/goals/evaluate','POST',{...ref,goal})).toEqual(evaluated);
    expect(calls).toEqual(['evaluate:count','evaluate:generate']);
    const view={...ref,goal:{...goal,filter:'strong',order:'fit',evaluationKey:evaluated.evaluationKey}};
    const exported=await staff('/staff/export','POST',view);
    expect(exported.status).toBe(200);
    expect(await exported.text()).toMatch(/Strong fit only .* Shown: 1 .* Hidden: 1/);
    expect((await staff('/staff/explain','POST',view)).status).toBe(429);
    expect(calls).toHaveLength(2);
    await send(second,'/staff/explain','POST',view);
    expect(lastExplanation?.goalReview).toMatchObject({filter:'Strong fit only',visibleOrder:[first.id],
      counts:{match:1,information:1},options:expect.arrayContaining([{id:unknown.id,requirements:'unknown',eligibility:'meets',
        checks:['start','ready'],fit:'insufficient',reason:'Delivery evidence is missing.',missing:['Delivery readiness'],conflict:null}])});
    expect(calls).toEqual(['evaluate:count','evaluate:generate','explain:count','explain:generate']);
    const included=await staff('/staff/export','POST',view);
    expect(await included.text()).toContain('## AI explanation');
    const other=await staff('/staff/export','POST',{...view,goal:{...view.goal,filter:'all'}});
    expect(await other.text()).not.toContain('## AI explanation');
    const finished=await db.prepare('SELECT started FROM ai_staff_usage WHERE pending_until=0').all<{started:number}>();
    expect(finished.results).toHaveLength(2);
    expect(ai.staffCooldownMs).toBe(15_000);
    await db.prepare("UPDATE ai_staff_usage SET started=started-? WHERE pending_until=0").bind(15_000).run();
    expect(await send(second,'/staff/goals/preview','POST',{...ref,goal:deliveryGoal})).toMatchObject({evaluationKey:null});
    const contrasted=await send<{evaluationKey:string;evaluation:import('../src/goals').GoalEvaluation}>(
      staff,'/staff/goals/evaluate','POST',{...ref,goal:deliveryGoal});
    expect(contrasted.evaluationKey).not.toBe(evaluated.evaluationKey);
    expect(contrasted.evaluation.assessments).toContainEqual(expect.objectContaining({
      id:unknown.id,fit:'strong',reason:'The staging slot is confirmed.',
    }));
    expect(assessmentGoals).toEqual([
      expect.objectContaining({id:goal.id,version:1,earliestStart:dateGoal.earliestStart,
        targetCompletion:dateGoal.targetCompletion,allowedTypes:[expect.arrayContaining(['pull-up'])]}),
      expect.objectContaining({id:deliveryGoal.id,version:1,earliestStart:null,targetCompletion:null,allowedTypes:[]}),
    ]);
    expect(await send(second,'/staff/goals/preview','POST',{...ref,goal})).toMatchObject({evaluationKey:evaluated.evaluationKey});
    await send(second,'/staff/goals/'+deliveryGoal.id,'PUT',{...delivery,description:'Prioritize documented utility review.',version:1});
    expect((await staff('/staff/goals/preview','POST',{...ref,goal:deliveryGoal})).status).toBe(409);
    const edited={...deliveryGoal,version:2};
    expect(await send(staff,'/staff/goals/preview','POST',{...ref,goal:edited})).toMatchObject({evaluationKey:null});
    const revised=await send<{evaluationKey:string;evaluation:import('../src/goals').GoalEvaluation}>(
      second,'/staff/goals/evaluate','POST',{...ref,goal:edited});
    expect(revised.evaluationKey).not.toBe(contrasted.evaluationKey);
    expect(revised.evaluation.assessments).toContainEqual(expect.objectContaining({reason:'The revised goal prioritizes utility review.'}));
    expect(assessmentGoals.at(-1)).toMatchObject({id:deliveryGoal.id,version:2,description:'Prioritize documented utility review.'});
    await db.prepare("UPDATE candidates SET notes='Changed synthetic evidence' WHERE id=?").bind(first.id).run();
    expect((await staff('/staff/goals/preview','POST',{...ref,goal})).status).toBe(409);
    const next=await reference();
    expect(await send(staff,'/staff/goals/preview','POST',{...next,goal})).toMatchObject({evaluationKey:null});
  } finally {vi.unstubAllGlobals();}
});

it('blocks oversized evaluation before calling the provider and allows explicit selected-site comparisons',async()=>{
  await db.batch(Array.from({length:goalLimits.options+1},(_,i)=>db.prepare(`INSERT INTO candidates
    (id,name,category,lat,lng,feasibility,costs,notes) VALUES (?,?,'pull-up',?,?,'suitable-for-comparison',?,'')`)
    .bind(`scope-${i}`,`Scope ${i}`,pilot.center.lat,pilot.center.lng,JSON.stringify(costs))));
  const goal=await makeGoal({...dateGoal,allowedTypes:[]});
  const ref=await reference();
  const provider=vi.fn();
  const realFetch=fetch;
  vi.stubGlobal('fetch',(input:RequestInfo|URL,init?:RequestInit)=>String(input).startsWith('https://api.openai.com/')?
    provider(input,init):realFetch(input,init));
  try {
    expect(await send(staff,'/staff/goals/evaluate','POST',{...ref,goal})).toMatchObject({blocked:expect.stringContaining('Narrow the comparison')});
    expect(provider).not.toHaveBeenCalled();
    const scoped=await reference({...scene,selected:['scope-0'],selectedOnly:true});
    expect(await send(staff,'/staff/goals/preview','POST',{...scoped,goal})).toMatchObject({blocked:null,evaluation:null});
  } finally {vi.unstubAllGlobals();}
});

it('reserves one dispatch for concurrent staff requests and discards a result when the goal changes in flight',async()=>{
  await db.prepare('UPDATE ai_staff_usage SET started=0 WHERE pending_until=0').run();
  const goal=await makeGoal({...dateGoal,name:'Concurrent review'});
  const ref=await reference({...scene,selected:['scope-0'],selectedOnly:true});
  const input={...ref,goal};
  const spentBefore=Number(await db.prepare('SELECT spent FROM ai_total WHERE id=1').first('spent'));
  const attemptsBefore=Number(await db.prepare('SELECT sum(attempts) AS total FROM ai_day').first('total'));
  const realFetch=fetch;
  let start=()=>{};
  let finish=()=>{};
  const started=new Promise<void>(resolve=>{start=resolve;});
  const release=new Promise<void>(resolve=>{finish=resolve;});
  let dispatches=0;
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(!url.startsWith('https://api.openai.com/'))return realFetch(input,init);
    if(url.endsWith('/input_tokens'))return Response.json({input_tokens:750});
    dispatches++;
    start();
    await release;
    return Response.json({status:'completed',usage:{input_tokens:750,output_tokens:100},
      output:[{content:[{type:'output_text',text:JSON.stringify({clarification:'What outcome best defines readiness?',assessments:[]})}]}]});
  });
  try {
    const pending=staff('/staff/goals/evaluate','POST',input);
    await started;
    expect((await second('/staff/goals/evaluate','POST',input)).status).toBe(409);
    expect((await staff('/staff/explain','POST',ref)).status).toBe(409);
    await send(second,'/staff/goals/'+goal.id,'PUT',{...dateGoal,version:goal.version,name:'Revised concurrent review'});
    finish();
    expect((await pending).status).toBe(409);
    expect(dispatches).toBe(1);
    expect(Number(await db.prepare('SELECT sum(attempts) AS total FROM ai_day').first('total'))-attemptsBefore).toBe(1);
    expect(Number(await db.prepare('SELECT spent FROM ai_total WHERE id=1').first('spent'))).toBeGreaterThan(spentBefore);
    expect(await send(staff,'/staff/goals/preview','POST',{...ref,goal:{...goal,version:2}})).toMatchObject({evaluationKey:null});
  } finally {finish();vi.unstubAllGlobals();}
});
