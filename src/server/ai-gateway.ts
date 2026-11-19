import { ai } from '../../config/settings';
import { travel } from '../../config/travel';
import type { GoalRef } from '../goals';
import { comparisonRevisionSQL, stmt } from './database';
import { problem, type Env } from './web';

type Parsed<T> = {explanation:T;providerOutput:unknown;reason?:never} | {reason:string;explanation?:never;providerOutput?:never};
export type GenerationContext={testWorkspace?:boolean;goal?:GoalRef;staffScope?:string;feature?:'goal'};
type Job<T> = {
  payload:object; generation:{max_output_tokens:number}; key:string; revision:number; cacheMs:number;
  parse:(text:string)=>Parsed<T>; scope?:string; context?:GenerationContext;
};
const currentData=(revision:number,context?:GenerationContext)=>{
  const goal=context?.goal;
  return {
    where:`(${comparisonRevisionSQL(context?.testWorkspace)})=?`+
      (goal?' AND EXISTS(SELECT 1 FROM program_goals WHERE id=? AND version=? AND deleted_at IS NULL)':''),
    args:[revision,...(goal?[goal.id,goal.version]:[])],
  };
};
export async function verifyAIContext(db:D1Database,revision:number,context?:GenerationContext) {
  const data=currentData(revision,context);
  if(!await stmt(db,`SELECT 1 WHERE ${data.where}`,...data.args).first()) {
    problem(409,'Data or the selected goal changed. Refresh the comparison.');
  }
}

export async function hash(text:string) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function modelParameters(env:Env) {
  if(!env.OPENAI_MODEL || !env.OPENAI_REASONING_EFFORT) problem(503,'AI is unavailable. Configure the shared model and reasoning effort.');
  return {model:env.OPENAI_MODEL,reasoning:{effort:env.OPENAI_REASONING_EFFORT}};
}

export function fitsInput(payload:object) {
  return new TextEncoder().encode(JSON.stringify(payload)).length<=ai.inputBytes;
}

async function checkResident(db:D1Database,scope:string,day:string,now:number) {
  const usage=await stmt(db,'SELECT day,attempts,started,pending_until FROM ai_resident_usage WHERE scope=?',scope)
    .first<{day:string;attempts:number;started:number;pending_until:number}>();
  if(!usage) return;
  if(usage.day===day && usage.attempts>=travel.ai.daily) problem(429,'Your daily suggestion limit has been reached. Try again tomorrow (UTC).');
  const seconds=Math.ceil((Math.max(usage.started+travel.ai.cooldownMs,usage.pending_until)-now)/1000);
  if(seconds>0) problem(429,`Try generating another suggestion in ${seconds} seconds.`);
}
async function checkStaff(db:D1Database,scope:string,now:number) {
  const usage=await stmt(db,'SELECT started,pending_until FROM ai_staff_usage WHERE scope=?',scope)
    .first<{started:number;pending_until:number}>();
  if(!usage)return;
  if(usage.pending_until>now)problem(409,'An AI request is already running for your account.');
  const seconds=Math.ceil((usage.started+ai.staffCooldownMs-now)/1000);
  if(seconds>0)problem(429,`Try generating again in ${seconds} seconds. Current cached results are still available.`);
}

export async function generate<T>(env:Env,job:Job<T>,provider:typeof fetch=fetch,requestId?:string) {
  const pricing=[env.AI_BUDGET_MICROUSD,env.AI_INPUT_MICROUSD_PER_MILLION,env.AI_OUTPUT_MICROUSD_PER_MILLION]
    .map(value=>/^\d+$/.test(value??'')?Number(value):0);
  if(env.AI_ENABLED!=='true'||!env.OPENAI_API_KEY||!pricing.every(value=>Number.isSafeInteger(value)&&value>0&&value<=1e12)) {
    problem(503,job.scope?'AI suggestions are unavailable. You can still compare locations and open Maps.':'AI is unavailable. Comparisons and exports still work.');
  }
  const {payload,generation,key,scope,revision,parse,context}=job;
  const staffScope=context?.staffScope;
  const goalJob=context?.feature==='goal';
  const [budget,inputPrice,outputPrice]=pricing;
  const db=env.DB;
  if(await stmt(db,'SELECT ai_frozen FROM operations WHERE id=1').first<number>('ai_frozen')) {
    problem(503,'AI is disabled for this restored environment.');
  }
  if(!fitsInput(payload)) problem(400,goalJob?'This goal assessment exceeds the input limit. Narrow the comparison.':
    scope?'This search is too large to explain.':'This comparison is too large to explain.');
  const prior=await stmt(db,'SELECT result FROM ai_jobs WHERE key=? AND expires>?',key,Date.now()).first<{result:string|null}>();
  if(prior) {
    if(!prior.result) problem(409,'An explanation is already being prepared. Try again shortly.');
    const {explanation}=parse(prior.result);
    if(explanation!==undefined) {
      await verifyAIContext(db,revision,context);
      return {value:explanation,cached:true};
    }
    await stmt(db,'DELETE FROM ai_jobs WHERE key=? AND result=?',key,prior.result).run();
  }
  const date=(now:number)=>new Date(now).toISOString().slice(0,10);
  if(scope) {
    const now=Date.now();
    await checkResident(db,scope,date(now),now);
  }
  if(staffScope)await checkStaff(db,staffScope,Date.now());
  if(context?.goal)await verifyAIContext(db,revision,context);
  const call=(endpoint:string,data:object)=>provider(`https://api.openai.com/v1/responses${endpoint}`,{
    method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(25_000),
  });
  const countResponse=await call('/input_tokens',payload).catch(()=>problem(502,'The explanation provider is unavailable.'));
  if(!countResponse.ok) problem(502,'The explanation provider could not count input tokens.');
  const counted=await countResponse.json().catch(()=>problem(502,'The provider returned an invalid token count.'));
  const count=Number((counted as {input_tokens?:number}|null)?.input_tokens);
  if(!Number.isSafeInteger(count)||count<=0||count>ai.inputTokens) problem(400,goalJob?
    'This goal assessment exceeds the input limit. Narrow the comparison.':'This request exceeds the explanation input limit.');
  const quote=(input:number,output:number)=>Math.ceil(input*inputPrice/1e6+output*outputPrice/1e6);
  const reserved=quote(ai.inputTokens,generation.max_output_tokens);
  const now=Date.now(), day=date(now), deadline=now+ai.reservationMs;
  const current=currentData(revision,context);
  const results=await db.batch([
    stmt(db,'DELETE FROM ai_jobs WHERE key=? AND expires<=?',key,now),
    stmt(db,'DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE expires<=? LIMIT 20)',now),
    stmt(db,'DELETE FROM ai_resident_usage WHERE scope IN (SELECT scope FROM ai_resident_usage WHERE started<? LIMIT 20)',now-travel.ai.cacheMs),
    stmt(db,'DELETE FROM ai_staff_usage WHERE scope IN (SELECT scope FROM ai_staff_usage WHERE started<? LIMIT 20)',now-ai.cacheDays*86_400_000),
    stmt(db,`INSERT OR IGNORE INTO ai_jobs(key,day,reserved,started,expires,resident_scope,staff_scope)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT spent FROM ai_total WHERE id=1)<=?
      AND coalesce((SELECT attempts FROM ai_day WHERE day=?),0)<?
      AND (SELECT suspended=0 AND ai_frozen=0 FROM operations WHERE id=1)
      AND NOT EXISTS(SELECT 1 FROM ai_resident_usage WHERE scope=? AND
        (started>? OR pending_until>? OR (day=? AND attempts>=?)))
      AND NOT EXISTS(SELECT 1 FROM ai_staff_usage WHERE scope=? AND (started>? OR pending_until>?))
      AND ${current.where}`,
      key,day,reserved,now,deadline,scope??null,staffScope??null,budget-reserved,day,ai.daily,
      scope??null,now-travel.ai.cooldownMs,now,day,travel.ai.daily,
      staffScope??null,now-ai.staffCooldownMs,now,...current.args),
  ]);
  if(!results.at(-1)?.meta.changes) {
    if(await stmt(db,'SELECT key FROM ai_jobs WHERE key=?',key).first()) problem(409,'An explanation was just requested. Try again shortly.');
    if(await stmt(db,'SELECT suspended OR ai_frozen AS unavailable FROM operations WHERE id=1').first<number>('unavailable')) {
      problem(503,'AI is unavailable.');
    }
    if(scope) await checkResident(db,scope,day,now);
    if(staffScope)await checkStaff(db,staffScope,now);
    await verifyAIContext(db,revision,context);
    problem(429,'The shared AI budget or daily limit has been reached.');
  }
  const response=await call('',{...payload,...generation})
    .catch(()=>problem(502,'The provider did not respond. Usage remains reserved.'));
  if(!response.ok) problem(502,'The provider could not generate an explanation.');
  const value=await response.json().catch(()=>problem(502,'The provider returned an invalid explanation.')) as {
    status?:string;usage?:{input_tokens:number;output_tokens:number};output?:{content?:{type:string;text?:string}[]}[];
  };
  if(!value||typeof value!=='object') problem(502,'The provider returned an invalid explanation.');
  const {usage}=value;
  const knownUsage=usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
    && usage.input_tokens>=0 && usage.output_tokens>=0;
  const charge=knownUsage?quote(usage.input_tokens,usage.output_tokens):reserved;
  if(knownUsage&&(usage.input_tokens>ai.inputTokens||usage.output_tokens>generation.max_output_tokens)) {
    await db.batch([
      stmt(db,'UPDATE operations SET ai_frozen=1 WHERE id=1'),
      stmt(db,'UPDATE ai_jobs SET reserved=? WHERE key=? AND started=?',Math.max(reserved,charge),key,now),
    ]);
    problem(502,'The provider exceeded the configured token bounds. AI has been disabled.');
  }
  const parts=(Array.isArray(value.output)?value.output:[]).flatMap(item=>Array.isArray(item?.content)?item.content:[]);
  const content=parts.find(item=>item?.type==='output_text')?.text;
  const parsed:Parsed<T>=value.status!=='completed'?{reason:'response_incomplete'}
    :parts.some(item=>item?.type==='refusal')?{reason:'provider_refusal'}
    :typeof content!=='string'?{reason:'missing_output'}:parse(content);
  const accepted=parsed.explanation!==undefined;
  const [confirmed]=await db.batch<{value:number}>([
    stmt(db,`SELECT 1 AS value WHERE ${current.where}`,...current.args),
    stmt(db,`UPDATE ai_jobs SET reserved=?,
      result=CASE WHEN ${current.where} THEN ? ELSE NULL END,
      expires=CASE WHEN ? IS NOT NULL AND ${current.where} THEN ? ELSE ? END
      WHERE key=? AND started=?`,
      charge,...current.args,accepted?JSON.stringify(parsed.providerOutput):null,accepted?1:null,
      ...current.args,now+job.cacheMs,Date.now(),key,now),
    ...(scope?[stmt(db,'UPDATE ai_resident_usage SET pending_until=0 WHERE scope=? AND job_key=?',scope,key)]:[]),
    ...(staffScope?[stmt(db,'UPDATE ai_staff_usage SET pending_until=0 WHERE scope=? AND job_key=?',staffScope,key)]:[]),
    stmt(db,`DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE result IS NOT NULL
      ORDER BY started DESC,key LIMIT 20 OFFSET ?)`,ai.cacheEntries),
    stmt(db,'DELETE FROM ai_day WHERE day IN (SELECT day FROM ai_day WHERE day<? LIMIT 10)',date(now-8*86_400_000)),
  ]);
  if(!confirmed.results.length) problem(409,'Data changed during generation. Refresh the comparison.');
  if(parsed.explanation===undefined) {
    console.warn(JSON.stringify({level:'warn',operation:goalJob?'goal_evaluation_rejected':'ai_explanation_rejected',requestId,reason:parsed.reason}));
    const resultName=goalJob?'goal evaluation':'explanation';
    const message=parsed.reason==='response_incomplete'?`The provider did not finish the ${resultName}. Try again.`
      :parsed.reason==='provider_refusal'?(goalJob?'The provider declined the goal evaluation.':'The provider declined to explain this comparison.')
        :`The provider returned an invalid ${resultName}.`;
    problem(502,message);
  }
  return {value:parsed.explanation,cached:false};
}
