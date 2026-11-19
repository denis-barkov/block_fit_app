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
type ProviderResponse = {
  status?:string;usage?:{input_tokens:number;output_tokens:number};output?:{content?:{type:string;text?:string}[]}[];
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

async function checkCooldown(db:D1Database,role:'resident'|'staff',scope:string) {
  const started=await stmt(db,`SELECT started FROM ai_${role}_usage WHERE scope=?`,scope).first<number>('started');
  if(started===null)return;
  const seconds=Math.ceil((started+ai.cooldownMs[role]-Date.now())/1000);
  if(seconds>0)problem(429,`Try generating again in ${seconds} seconds.`);
}

export async function generate<T>(env:Env,job:Job<T>,provider:typeof fetch=fetch,requestId?:string) {
  if(env.AI_ENABLED!=='true'||!env.OPENAI_API_KEY) {
    problem(503,job.scope?'AI suggestions are unavailable. You can still compare locations and open Maps.':'AI is unavailable. Comparisons and exports still work.');
  }
  const {payload,generation,key,scope,revision,parse,context}=job;
  const staffScope=context?.staffScope;
  const goalJob=context?.feature==='goal';
  const db=env.DB;
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
  if(scope)await checkCooldown(db,'resident',scope);
  if(staffScope)await checkCooldown(db,'staff',staffScope);
  if(context?.goal)await verifyAIContext(db,revision,context);
  const call=(endpoint:string,data:object)=>provider(`https://api.openai.com/v1/responses${endpoint}`,{
    method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(25_000),
  });
  const now=Date.now(), day=new Date(now).toISOString().slice(0,10), deadline=now+ai.reservationMs;
  const current=currentData(revision,context);
  const results=await db.batch([
    stmt(db,'DELETE FROM ai_jobs WHERE key=? AND expires<=?',key,now),
    stmt(db,'DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE expires<=? LIMIT 20)',now),
    stmt(db,'DELETE FROM ai_resident_usage WHERE scope IN (SELECT scope FROM ai_resident_usage WHERE started<? LIMIT 20)',now-travel.ai.cacheMs),
    stmt(db,'DELETE FROM ai_staff_usage WHERE scope IN (SELECT scope FROM ai_staff_usage WHERE started<? LIMIT 20)',now-ai.cacheDays*86_400_000),
    stmt(db,`INSERT OR IGNORE INTO ai_jobs(key,day,reserved,started,expires,resident_scope,staff_scope)
      SELECT ?,?,0,?,?,?,? WHERE (SELECT suspended=0 FROM operations WHERE id=1)
      AND NOT EXISTS(SELECT 1 FROM ai_resident_usage WHERE scope=? AND started>?)
      AND NOT EXISTS(SELECT 1 FROM ai_staff_usage WHERE scope=? AND started>?)
      AND ${current.where}`,
      key,day,now,deadline,scope??null,staffScope??null,
      scope??null,now-ai.cooldownMs.resident,
      staffScope??null,now-ai.cooldownMs.staff,...current.args),
  ]);
  if(!results.at(-1)?.meta.changes) {
    if(await stmt(db,'SELECT key FROM ai_jobs WHERE key=?',key).first()) problem(409,'An explanation was just requested. Try again shortly.');
    if(await stmt(db,'SELECT suspended FROM operations WHERE id=1').first<number>('suspended')) {
      problem(503,'AI is unavailable.');
    }
    if(scope) await checkCooldown(db,'resident',scope);
    if(staffScope)await checkCooldown(db,'staff',staffScope);
    await verifyAIContext(db,revision,context);
    problem(409,'An AI request was just started. Try again shortly.');
  }
  let value:ProviderResponse;
  try {
    const countResponse=await call('/input_tokens',payload).catch(()=>problem(502,'The explanation provider is unavailable.'));
    if(!countResponse.ok) problem(502,'The explanation provider could not count input tokens.');
    const counted=await countResponse.json().catch(()=>problem(502,'The provider returned an invalid token count.'));
    const count=Number((counted as {input_tokens?:number}|null)?.input_tokens);
    if(!Number.isSafeInteger(count)||count<=0||count>ai.inputTokens) problem(400,goalJob?
      'This goal assessment exceeds the input limit. Narrow the comparison.':'This request exceeds the explanation input limit.');
    const response=await call('',{...payload,...generation}).catch(()=>problem(502,'The provider did not respond.'));
    if(!response.ok) problem(502,'The provider could not generate an explanation.');
    value=await response.json().catch(()=>problem(502,'The provider returned an invalid explanation.')) as ProviderResponse;
    if(!value||typeof value!=='object') problem(502,'The provider returned an invalid explanation.');
  } catch(error) {
    await stmt(db,'DELETE FROM ai_jobs WHERE key=? AND started=? AND result IS NULL',key,now).run();
    throw error;
  }
  const {usage}=value;
  const knownUsage=usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
    && usage.input_tokens>=0 && usage.output_tokens>=0;
  const exceededBounds=knownUsage&&(usage.input_tokens>ai.inputTokens||usage.output_tokens>generation.max_output_tokens);
  const parts=(Array.isArray(value.output)?value.output:[]).flatMap(item=>Array.isArray(item?.content)?item.content:[]);
  const content=parts.find(item=>item?.type==='output_text')?.text;
  const parsed:Parsed<T>=exceededBounds?{reason:'token_bounds'}:value.status!=='completed'?{reason:'response_incomplete'}
    :parts.some(item=>item?.type==='refusal')?{reason:'provider_refusal'}
    :typeof content!=='string'?{reason:'missing_output'}:parse(content);
  const accepted=parsed.explanation!==undefined;
  const [confirmed]=await db.batch<{value:number}>([
    stmt(db,`SELECT 1 AS value WHERE ${current.where}`,...current.args),
    stmt(db,`UPDATE ai_jobs SET
      result=CASE WHEN ${current.where} THEN ? ELSE NULL END,
      expires=CASE WHEN ? IS NOT NULL AND ${current.where} THEN ? ELSE ? END
      WHERE key=? AND started=?`,
      ...current.args,accepted?JSON.stringify(parsed.providerOutput):null,accepted?1:null,
      ...current.args,now+job.cacheMs,Date.now(),key,now),
    stmt(db,`DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE result IS NOT NULL
      ORDER BY started DESC,key LIMIT 20 OFFSET ?)`,ai.cacheEntries),
  ]);
  if(!confirmed.results.length) problem(409,'Data changed during generation. Refresh the comparison.');
  if(parsed.explanation===undefined) {
    console.warn(JSON.stringify({level:'warn',operation:goalJob?'goal_evaluation_rejected':'ai_explanation_rejected',requestId,reason:parsed.reason}));
    const resultName=goalJob?'goal evaluation':'explanation';
    const message=parsed.reason==='token_bounds'?'The provider exceeded the configured token bounds.'
      :parsed.reason==='response_incomplete'?`The provider did not finish the ${resultName}. Try again.`
      :parsed.reason==='provider_refusal'?(goalJob?'The provider declined the goal evaluation.':'The provider declined to explain this comparison.')
        :`The provider returned an invalid ${resultName}.`;
    problem(502,message);
  }
  return {value:parsed.explanation,cached:false};
}
