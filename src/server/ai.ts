import { z } from 'zod';
import { ai, staffComparisonAI } from '../../config/settings';
import { explanationSchema, type Explanation } from '../contracts';
import { comparisonSnapshot } from './ai-comparison';
import { loadPrompt } from './prompts';
import { stmt } from './database';
import type { Comparison } from './planning';
import { problem, type Env } from './web';
import { generate, inputSizeError, hash, modelParameters, type GenerationContext } from './ai-gateway';
import type { goalExplanationContext } from './goal-evaluation';

const section = z.string().max(staffComparisonAI.explanation.sectionChars);
const providerExplanationSchema = explanationSchema.omit({highlightedOptionIds:true}).extend({
  summary:section.min(1),tradeoffs:section,checks:section,
  referencedOptionIds:z.array(z.string()).max(staffComparisonAI.explanation.detailOptions),
});
const { $schema, ...outputSchema } = z.toJSONSchema(providerExplanationSchema);
const schemaVersion = 4;
const generation = {store:false,service_tier:'default',max_output_tokens:staffComparisonAI.explanation.outputTokens} as const;

type GoalExplanation=ReturnType<typeof goalExplanationContext>;
export function explanationRequest(env: Env, comparison: Comparison, goal?:GoalExplanation) {
  const content = loadPrompt('explain-investment-options',{output_word_limit:ai.outputWords});
  const snapshot = comparisonSnapshot(comparison);
  const {options:reviewRows=[],...goalReview}=goal??{};
  const rowsById=new Map(reviewRows.map(({id,...row})=>[id,row]));
  const input=goal?{...snapshot,goalReview,options:snapshot.options.map(option=>({
    ...option,goal:rowsById.get(option.id),
  }))}:snapshot;
  const payload = {
    ...modelParameters(env),
    input:[{role:'developer',content},{role:'user',content:JSON.stringify(input)}],
    text:{format:{type:'json_schema',name:'comparison_explanation',strict:true,schema:outputSchema}},
  };
  return {payload,snapshot,generation,size:{options:snapshot.options.length,limits:staffComparisonAI.explanation},
    parse:(content:string)=>parseExplanation(content,snapshot)};
}

export async function explanationCacheKey(revision: number, request: ReturnType<typeof explanationRequest>, version = schemaVersion) {
  const input = JSON.stringify([version,revision,request.payload,request.generation,request.size]);
  return hash(input);
}

function parseExplanation(content: string, snapshot: ReturnType<typeof comparisonSnapshot>) {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return {reason:'invalid_json'} as const; }
  const parsed = providerExplanationSchema.safeParse(value);
  if (!parsed.success) return {reason:'invalid_shape'} as const;
  const result = parsed.data;
  const sections = [result.summary,result.tradeoffs,result.checks].map(section => section.trim());
  if (!sections[0]) return {reason:'empty_summary'} as const;
  const knownIds = new Set(snapshot.options.map(option => option.id));
  if (result.referencedOptionIds.some(id => !knownIds.has(id))) return {reason:'unknown_option'} as const;
  const providerOutput = {summary:sections[0],tradeoffs:sections[1],checks:sections[2],
    referencedOptionIds:[...new Set(result.referencedOptionIds)]};
  const explanation: Explanation = {...providerOutput,highlightedOptionIds:snapshot.ranking.highlightedOptionIds};
  return {explanation,providerOutput} as const;
}

export async function cachedExplanation(env: Env, comparison: Comparison, goal?:GoalExplanation) {
  let request;
  try { request = explanationRequest(env,comparison,goal); }
  catch { return; }
  if (inputSizeError(request)) return;
  const record = await stmt(env.DB,'SELECT result FROM ai_jobs WHERE key=? AND expires>? AND result IS NOT NULL',
    await explanationCacheKey(comparison.revision,request),Date.now()).first<{result:string}>();
  return record ? parseExplanation(record.result,request.snapshot).explanation : undefined;
}

export async function explain(env: Env, comparison: Comparison, provider: typeof fetch = fetch, requestId?: string, context?:GenerationContext,goal?:GoalExplanation) {
  let request;
  try { request = explanationRequest(env,comparison,goal); }
  catch { problem(503,'This comparison could not be prepared for AI. Comparisons and exports still work.'); }
  const result=await generate(env,{
    requests:[request],key:await explanationCacheKey(comparison.revision,request),revision:comparison.revision,context,
    cacheMs:ai.cacheDays*86_400_000,parse:content=>parseExplanation(content,request.snapshot),
  },provider,requestId);
  return result.value;
}
