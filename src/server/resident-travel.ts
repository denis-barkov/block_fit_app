import type { Context } from 'hono';
import { z } from 'zod';
import { ai, categories, limits } from '../../config/settings';
import { travel } from '../../config/travel';
import { isInServiceArea } from '../../config/map-area';
import { category, coordinate, type PublicEquipment } from '../contracts';
import { byDistance, eligible, landmarkModes, normalizeLandmarks, originEndpoint, reasonText, travelReasons } from '../travel';
import { generate, hash, modelParameters } from './ai-gateway';
import { inventory, stmt, throttle } from './database';
import { loadPrompt } from './prompts';
import { body, problem, type App } from './web';

const siteId=z.string().min(1).max(64);
const inputSchema=z.object({
  category, query:z.string().trim().max(limits.shortText),
  origin:coordinate.refine(isInServiceArea,'Choose a pin in Brooklyn or Queens.'),
  target:siteId.nullable(),
  observations:z.record(siteId,z.array(coordinate.extend({
    mode:z.enum(landmarkModes),name:z.string().max(travel.map.nameLength),
    featureId:z.string().min(1).max(travel.map.featureIdLength).optional(),
  }).strict()).max(travel.map.perMode*landmarkModes.length))
    .refine(value=>Object.keys(value).length<=travel.pool+2),
}).strict();

const output=z.object({options:z.array(z.object({id:z.string(),reason:z.enum(travelReasons)}).strict())}).strict();
const {$schema,...schema}=z.toJSONSchema(output);

export async function suggestTravel(c:Context<App>) {
  const user=c.get('user');
  if(user.purpose==='automated-test') problem(403,'AI suggestions are unavailable for automated-test accounts.');
  const input=await body(c,inputSchema);
  const env=c.env, db=env.DB;
  const scope=await hash(JSON.stringify(['resident-travel',env.AUTH_SECRET,user.id]));
  if(!await throttle(db,`travel:${scope}`,travel.ai.requestsPerWindow)) problem(429,'Too many suggestion requests. Try again later.');
  const revision=(await stmt(db,'SELECT value FROM revision WHERE id=1').first<number>('value'))!;
  let after='';
  let pool: ReturnType<typeof byDistance<PublicEquipment>>=[];
  let direct: typeof pool[number] | undefined;
  for(;;) {
    const page=await inventory(db,input.category,input.query,after,true);
    const ranked=byDistance(page.filter(eligible),input.origin);
    direct ??= ranked.find(({site})=>site.id===input.target);
    pool=[...pool,...ranked].sort((a,b)=>a.distance-b.distance || (a.site.id<b.site.id?-1:1)).slice(0,travel.pool);
    if(page.length<travel.pageSize) break;
    after=page[page.length-1].id;
  }
  if(input.target && !direct) problem(409,'This location is no longer eligible. Refresh your search.');
  const candidates=direct && !pool.some(item=>item.site.id===direct.site.id)?[...pool,direct]:pool;
  const recommended=direct?[direct]:pool.slice(0,travel.shortlist);
  if(!recommended.length) return c.json({options:[],cached:false,evidence:'unavailable'});
  const observed=(id:string,point:typeof input.origin)=>normalizeLandmarks(point,
    Object.hasOwn(input.observations,id)?input.observations[id]:[]);
  const origin=observed(originEndpoint,input.origin);
  const observations=candidates.map(({site})=>observed(site.id,site));
  const summarize=(points:typeof origin)=>landmarkModes.flatMap(mode=>{
    const first=points.find(point=>point.mode===mode);
    return first?[{mode,name:first.name}]:[];
  });
  const evidence=origin.length||observations.some(points=>points.length)?'partial':'unavailable';
  const facts=candidates.map(({site,distance},index)=>({
    id:site.id,name:site.name,approxMetres:Math.round(distance),condition:site.condition,access:site.access,fixture:site.fixture,
    landmarks:summarize(observations[index]),
    compatibleModes:site.fixture?[]:landmarkModes.filter(mode=>origin.some(point=>point.mode===mode) &&
      observations[index].some(point=>point.mode===mode)),
  }));
  const ids=recommended.map(({site})=>site.id);
  const wordLimit=direct?travel.ai.focusedWords:travel.ai.shortlistWords;
  const instructions=loadPrompt(direct?'explore-destination':'choose-destinations',{output_word_limit:wordLimit});
  const payload={
    ...modelParameters(env),
    input:[{role:'developer',content:instructions},{role:'user',content:JSON.stringify({
      category:categories[input.category],recommendationIds:ids,evidence,originLandmarks:summarize(origin),destinations:facts,
    })}],
    text:{format:{type:'json_schema',name:'destination_suggestions',strict:true,schema}},
  };
  const generation={store:false,service_tier:'default',max_output_tokens:ai.outputTokens};
  const key=await hash(JSON.stringify([scope,revision,input.origin,input.category,input.query,input.target,
    origin,observations,payload,generation,ai.inputTokens]));
  const result=await generate(env,{payload,generation,revision,key,scope,cacheMs:travel.ai.cacheMs,parse:text=>{
    let value:unknown;
    try {value=JSON.parse(text);} catch {return {reason:'invalid_json'};}
    const parsed=output.safeParse(value);
    if(!parsed.success || parsed.data.options.length!==ids.length) return {reason:'invalid_options'};
    for(const [index,entry] of parsed.data.options.entries()) {
      if(entry.id!==ids[index] || reasonText[entry.reason].split(/\s+/).length>wordLimit) return {reason:'invalid_recommendation'};
      const modes=facts.find(site=>site.id===entry.id)?.compatibleModes;
      if((entry.reason==='mapped-rail'&&!modes?.includes('rail')) ||
         (entry.reason==='mapped-bus'&&!modes?.includes('bus'))) return {reason:'unsupported_landmark'};
    }
    return {explanation:parsed.data.options,providerOutput:parsed.data};
  }},fetch,c.get('requestId'));
  return c.json({options:result.value,cached:result.cached,evidence});
}
