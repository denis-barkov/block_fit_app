import { z } from 'zod';
import { ai } from '../../config/settings';
import { explanationSchema, type Explanation } from '../contracts';
import { comparisonSnapshot } from './ai-comparison';
import { loadPrompt } from './prompts';
import { stmt } from './database';
import type { Comparison } from './planning';
import { problem, type Env } from './web';

const { $schema, ...outputSchema } = z.toJSONSchema(explanationSchema);
const schemaVersion = 2;
const generation = {store:false,service_tier:'default',max_output_tokens:ai.outputTokens} as const;

export function explanationRequest(env: Env, comparison: Comparison) {
  const content = loadPrompt('explain-investment-options',{output_word_limit:ai.outputWords});
  const snapshot = comparisonSnapshot(comparison);
  const payload = {
    model:env.OPENAI_MODEL || ai.model, reasoning:{effort:'none' as const},
    input:[{role:'developer',content},{role:'user',content:JSON.stringify(snapshot)}],
    text:{format:{type:'json_schema',name:'comparison_explanation',strict:true,schema:outputSchema}},
  };
  return {payload,snapshot,generation};
}

export async function explanationCacheKey(revision: number, request: ReturnType<typeof explanationRequest>, version = schemaVersion) {
  const input = JSON.stringify([version,revision,request.payload,request.generation,ai.inputTokens]);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
}

function validatedExplanation(content: string, snapshot: ReturnType<typeof comparisonSnapshot>): Explanation | undefined {
  if (content.length > 6_000) return;
  try {
    const result = explanationSchema.parse(JSON.parse(content));
    const sections = [result.summary,result.tradeoffs,result.checks].map(section => section.trim());
    if (!sections[0] || sections.some(section => section.length > 1200) ||
        sections.filter(Boolean).join(' ').split(/\s+/).length > ai.outputWords) return;
    const expected = snapshot.ranking.highlightedOptionIds;
    const actual = [...result.highlightedOptionIds].sort();
    if (actual.length !== expected.length || actual.some((id,index) => id !== expected[index])) return;
    const knownIds = new Set(snapshot.options.map(option => option.id));
    const referenced = new Set(result.referencedOptionIds);
    if (referenced.size !== result.referencedOptionIds.length ||
        result.referencedOptionIds.some(id => !knownIds.has(id)) ||
        expected.some(id => !referenced.has(id))) return;
    return {...result,summary:sections[0],tradeoffs:sections[1],checks:sections[2]};
  } catch { /* Invalid provider output. */ }
}

export async function cachedExplanation(env: Env, comparison: Comparison) {
  let request;
  try { request = explanationRequest(env,comparison); }
  catch { return; }
  if (!withinInputLimit(request)) return;
  const record = await stmt(env.DB,'SELECT result FROM ai_jobs WHERE key=? AND expires>? AND result IS NOT NULL',
    await explanationCacheKey(comparison.revision,request),Date.now()).first<{result:string}>();
  return record ? validatedExplanation(record.result,request.snapshot) : undefined;
}

function withinInputLimit({payload}: ReturnType<typeof explanationRequest>) {
  return new TextEncoder().encode(JSON.stringify(payload)).length <= ai.inputBytes;
}

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

  let request;
  try { request = explanationRequest(env,comparison); }
  catch { problem(503,'This comparison could not be prepared for AI. Comparisons and exports still work.'); }
  if (!withinInputLimit(request)) problem(400,'This comparison is too large to explain.');
  const {payload,snapshot} = request;
  const quote = (input: number, output: number) => Math.ceil(input*inputPrice/1e6 + output*outputPrice/1e6);
  const key = await explanationCacheKey(comparison.revision,request);
  const db = env.DB;
  const prior = await stmt(db,'SELECT result FROM ai_jobs WHERE key=? AND expires>?',key,Date.now()).first<{result:string|null}>();
  if (prior) {
    if (!prior.result) problem(409,'An explanation is already being prepared. Try again shortly.');
    const explanation = validatedExplanation(prior.result,snapshot);
    if (explanation) return explanation;
    await stmt(db,'DELETE FROM ai_jobs WHERE key=? AND result=?',key,prior.result).run();
  }
  const call = (endpoint: string, data: object) => provider(`https://api.openai.com/v1/responses${endpoint}`,{
    method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(25_000),
  });
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

  const response = await call('',{...payload,...request.generation})
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
  const explanation = value.status === 'completed' && typeof content === 'string'
    ? validatedExplanation(content,snapshot) : undefined;
  const [revision] = await db.batch<{value:number}>([
    stmt(db,'SELECT value FROM revision WHERE id=1'),
    stmt(db,`UPDATE ai_jobs SET reserved=?,
      result=CASE WHEN (SELECT value FROM revision WHERE id=1)=? THEN ? ELSE NULL END,
      expires=CASE WHEN ? IS NOT NULL AND (SELECT value FROM revision WHERE id=1)=? THEN ? ELSE ? END
      WHERE key=? AND started=?`,
      charge,comparison.revision,explanation?JSON.stringify(explanation):null,explanation?1:null,
      comparison.revision,now+ai.cacheDays*86_400_000,Date.now(),key,now),
    stmt(db,`DELETE FROM ai_jobs WHERE key IN (SELECT key FROM ai_jobs WHERE result IS NOT NULL
      ORDER BY started DESC,key LIMIT 20 OFFSET ?)`,ai.cacheEntries),
    stmt(db,'DELETE FROM ai_day WHERE day IN (SELECT day FROM ai_day WHERE day<? LIMIT 10)',
      new Date(now-8*86_400_000).toISOString().slice(0,10)),
  ]);
  if (revision.results[0].value !== comparison.revision) problem(409,'Data changed during generation. Refresh the comparison.');
  if (!explanation) problem(502,'The provider returned an invalid explanation.');
  return explanation;
}
