import { ai } from '../../config/settings';
import { explanationSchema } from '../contracts';
import { stmt } from './database';
import type { Comparison } from './planning';
import { problem, type Env } from './web';

function aggregate(result: Comparison) {
  return {
    scenario: { category:result.scenario.category, radius:result.scenario.radius,
      horizon:result.scenario.horizon, budgetCents:result.scenario.budget },
    demand:result.demandCount, unmet:result.unmet,
    options:result.options.map(option => ({
      sites:option.ids.map(id => result.sites.findIndex(site => site.id === id)+1).sort((a,b)=>a-b),
      feasibility:option.feasibility, coverage:option.count, estimates:option.estimates,
      missing:[...new Set(option.missing.map(entry => entry.key))],
    })),
  };
}
function modelFor(env: Env) { return env.OPENAI_MODEL || ai.model; }
async function cacheKey(env: Env, result: Comparison) {
  const scenario={...result.scenario,selected:[...result.scenario.selected].sort()};
  const input = JSON.stringify([ai.promptVersion,modelFor(env),result.revision,scenario,aggregate(result)]);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
}
export async function cachedExplanation(env: Env, comparison: Comparison) {
  const record = await stmt(env.DB,'SELECT result FROM ai_jobs WHERE key=? AND expires>? AND result IS NOT NULL',
    await cacheKey(env,comparison),Date.now()).first<{result:string}>();
  return record ? explanationSchema.parse(JSON.parse(record.result)) : undefined;
}

const outputFields = ['summary','tradeoffs','missing','limitations'];
export async function explain(env: Env, comparison: Comparison, provider: typeof fetch = fetch) {
  const pricing = [env.AI_BUDGET_MICROUSD,env.AI_INPUT_MICROUSD_PER_MILLION,env.AI_OUTPUT_MICROUSD_PER_MILLION]
    .map(value => /^\d+$/.test(value ?? '') ? Number(value) : 0);
  if (env.AI_ENABLED !== 'true' || !env.OPENAI_API_KEY || !pricing.every(value => Number.isSafeInteger(value) && value > 0 && value <= 1e12)) {
    problem(503,'AI is unavailable. Comparisons and exports still work.');
  }
  const [budget,inputPrice,outputPrice] = pricing;
  if (await stmt(env.DB,"SELECT ai_frozen FROM operations WHERE id=1").first<number>("ai_frozen")) {
    problem(503,"AI is disabled for this restored environment.");
  }

  const quote = (input: number, output: number) => Math.ceil(input*inputPrice/1e6 + output*outputPrice/1e6);
  const key = await cacheKey(env,comparison);
  const db = env.DB;
  const prior = await stmt(db,'SELECT result FROM ai_jobs WHERE key=? AND expires>?',key,Date.now()).first<{result:string|null}>();
  if (prior) {
    if (!prior.result) problem(409,'An explanation is already being prepared. Try again shortly.');
    return explanationSchema.parse(JSON.parse(prior.result));
  }
  const payload = {
    model:modelFor(env), reasoning:{effort:'none' as const},
    input:[{role:'developer', content:'Explain this aggregate investment comparison. Amounts are in cents. Use option numbers only. Do not invent amounts or recommend acceptance. Describe assumptions and limits.'},
      {role:'user', content:JSON.stringify(aggregate(comparison))}],
    text:{format:{type:'json_schema',name:'comparison_explanation',strict:true,schema:{
      type:'object',required:outputFields,additionalProperties:false,
      properties:Object.fromEntries(outputFields.map(field => [field,{type:'string'}])),
    }}},
  };
  const call = (endpoint: string, data: object) => provider(`https://api.openai.com/v1/responses${endpoint}`,{
    method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(25_000),
  });
  if (payload.input[1].content.length > 12_000) problem(400,'This comparison is too large to explain.');
  const countResponse = await call('/input_tokens',payload).catch(() => problem(502,'The explanation provider is unavailable.'));
  if (!countResponse.ok) problem(502,'The explanation provider could not count input tokens.');
  const counted = await countResponse.json().catch(() => problem(502,'The provider returned an invalid token count.'));
  const count = Number((counted as {input_tokens?:number} | null)?.input_tokens);
  if (!Number.isSafeInteger(count) || count <= 0 || count > ai.inputTokens) problem(400,'This comparison exceeds the explanation input limit.');
  const reserved = quote(ai.inputTokens,ai.outputTokens);
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0,10);
  const deadline = now+120_000;
  const [, , acquired] = await db.batch([
    stmt(db,'DELETE FROM ai_jobs WHERE key=? AND expires<=?',key,now),
    stmt(db,'DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE expires<=? LIMIT 20)',now),
    stmt(db,`INSERT OR IGNORE INTO ai_jobs(key,day,reserved,started,expires)
      SELECT ?,?,?,?,? WHERE (SELECT spent FROM ai_total WHERE id=1)<=?
      AND coalesce((SELECT attempts FROM ai_day WHERE day=?),0)<?
      AND (SELECT suspended=0 AND ai_frozen=0 FROM operations WHERE id=1)`,
      key,day,reserved,now,deadline,budget-reserved,day,ai.daily),
  ]);
  if (!acquired.meta.changes) {
    if (await stmt(db,'SELECT key FROM ai_jobs WHERE key=?',key).first()) problem(409,'An explanation was just requested. Try again shortly.');
    if (await stmt(db,'SELECT suspended OR ai_frozen AS unavailable FROM operations WHERE id=1').first<number>('unavailable')) {
      problem(503,'AI is unavailable.');
    }
    problem(429,'The explanation budget or daily limit has been reached.');
  }

  const response = await call('',{...payload,store:false,service_tier:'default',max_output_tokens:ai.outputTokens})
    .catch(() => problem(502,'The provider did not respond. Usage remains reserved.'));
  if (!response.ok) problem(502,'The provider could not generate an explanation.');
  const value = await response.json().catch(() => problem(502,'The provider returned an invalid explanation.')) as {
    status?: string; usage?: {input_tokens:number;output_tokens:number};
    output?: {content?: {type:string;text?:string}[]}[];
  };
  if (!value || typeof value !== 'object') problem(502,'The provider returned an invalid explanation.');
  const {usage} = value;
  const charge = usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens) &&
    usage.input_tokens >= 0 && usage.output_tokens >= 0
    ? Math.max(0,quote(usage.input_tokens,usage.output_tokens)) : reserved;
  if (usage && (usage.input_tokens > ai.inputTokens || usage.output_tokens > ai.outputTokens)) {
    await db.batch([
      stmt(db,'UPDATE operations SET ai_frozen=1 WHERE id=1'),
      stmt(db,'UPDATE ai_jobs SET reserved=? WHERE key=? AND started=?',Math.max(reserved,charge),key,now),
    ]);
    problem(502,'The provider exceeded the configured token bounds. AI has been disabled.');
  }
  const items = Array.isArray(value.output) ? value.output : [];
  const content = items.flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .find(item => item?.type === 'output_text')?.text;
  let explanation;
  if (value.status === 'completed' && content && content.length <= 6_000) {
    try { explanation = explanationSchema.parse(JSON.parse(content)); } catch { /* Invalid provider output. */ }
  }
  const [revision] = await db.batch<{value:number}>([
    stmt(db,'SELECT value FROM revision WHERE id=1'),
    stmt(db,`UPDATE ai_jobs SET reserved=?,
      result=CASE WHEN (SELECT value FROM revision WHERE id=1)=? THEN ? ELSE NULL END,
      expires=CASE WHEN ? IS NOT NULL AND (SELECT value FROM revision WHERE id=1)=? THEN ? ELSE ? END
      WHERE key=? AND started=?`,
      charge,comparison.revision,explanation?JSON.stringify(explanation):null,explanation?1:null,
      comparison.revision,now+ai.cacheDays*86_400_000,deadline,key,now),
    stmt(db,`DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE result IS NOT NULL
      ORDER BY started DESC,key LIMIT 20 OFFSET ?)`,ai.cacheEntries),
    stmt(db,'DELETE FROM ai_day WHERE day IN (SELECT day FROM ai_day WHERE day<? LIMIT 10)',
      new Date(now-8*86_400_000).toISOString().slice(0,10)),
  ]);
  if (revision.results[0].value !== comparison.revision) problem(409,'Data changed during generation. Refresh the comparison.');
  if (!explanation) problem(502,'The provider returned an invalid explanation.');
  return explanation;
}
