import { z } from 'zod';
import { goalLimits, structuredGoalDescription } from '../../config/goals';
import { ai, staffComparisonAI } from '../../config/settings';
import { costKeys } from '../contracts';
import { bucketLabels, evidenceLabels, fitLabels, fits, goalEvidenceKeys, goalFilterLabels, goalReasonLabels, goalRows, goalView, leadingGoalBasis, optionId, statusLabels, type Goal,
  type GoalEvaluation, type GoalFilter, type GoalOrder, type GoalRef } from '../goals';
import { generate, inputSizeError, hash, modelParameters, verifyAIContext, type GenerationContext } from './ai-gateway';
import { stmt } from './database';
import { clean, type Comparison } from './planning';
import { currentGoal } from './program-goals';
import { loadPrompt } from './prompts';
import { problem, type Env } from './web';

const assessmentSchema=z.object({
  id:z.string(),fit:z.enum(fits),reason:z.string(),evidence:z.array(z.string()),
  missing:z.array(z.string()),conflict:z.string().nullable(),
}).strict();
const responseSchema=z.object({clarification:z.string().nullable(),assessments:z.array(assessmentSchema)}).strict();
function outputSchema(expected:Map<string,Set<string>>) {
  const text=z.string().min(1).max(goalLimits.reasonChars);
  const groups=new Map<string,{ids:string[];citations:string[]}>();
  for(const [id,allowed] of expected) {
    const citations=[...allowed];
    const key=citations.join(',');
    const group=groups.get(key)??{ids:[],citations};
    group.ids.push(id);groups.set(key,group);
  }
  const variants=[...groups.values()].flatMap(({ids,citations})=>{
    const evidence=z.array(z.enum(citations)).max(goalLimits.evidence);
    const row=assessmentSchema.extend({
      id:z.enum(ids), reason:text,conflict:text.nullable(),
      missing:z.array(z.string().min(1).max(goalLimits.missingChars)).max(goalLimits.missing),
    });
    return [
      row.extend({fit:z.enum(fits.filter(fit=>fit!=='insufficient')),evidence:evidence.min(1)}),
      row.extend({fit:z.enum(['insufficient']),evidence}),
    ];
  });
  const {$schema,...schema}=z.toJSONSchema(responseSchema.extend({
    clarification:text.nullable(),assessments:z.array(z.union(variants)).max(expected.size),
  }));
  return schema;
}
const rubricVersion=2;

function snapshotForGoal(comparison:Comparison,goal:Goal) {
  const included=new Set(comparison.options.flatMap(option=>option.ids));
  const orderedSites=comparison.sites.filter(site=>included.has(site.id)).sort((a,b)=>a.id<b.id?-1:Number(a.id!==b.id));
  const ids=new Map(orderedSites.map((site,index)=>[site.id,index]));
  const rows=new Map(goalRows(comparison,goal).map(row=>[row.id,row]));
  const optionData=comparison.options.map(option=>{
    const id=optionId(option.ids);
    const row=rows.get(id)!;
    const base=option.estimates.base;
    return {id,sites:[...option.ids].sort().map(id=>ids.get(id)!),coverage:[option.count,option.overlap],
      costs:[base.upfront,base.lifecycle,base.fits,base.perRequester===null?null:Math.round(base.perRequester)],feasibility:option.feasibility,
      requirements:row.requirement,eligibility:row.eligibility,
      gaps:[...new Set(option.missing.map(item=>item.key))].sort(),
      requirementDetails:row.requirements.map(entry=>[entry.code,entry.site&&ids.get(entry.site)]),
    };
  }).sort((a,b)=>a.id<b.id?-1:Number(a.id!==b.id));
  const {scenario}=comparison;
  return {
    goal:{id:goal.id,version:goal.version,name:goal.name,description:goal.description,earliestStart:goal.earliestStart,targetCompletion:goal.targetCompletion,
      allowedTypes:goal.types.map(type=>[type.id,type.name,type.description,type.active])},
    scenario:{equipment:comparison.categoryName,equipmentId:scenario.category,budgetCents:scenario.budget,radiusMetres:scenario.radius,
      horizonYears:scenario.horizon,demandCount:comparison.demandCount,unmet:comparison.unmet,
      syntheticDemandCount:comparison.origins.filter(origin=>origin.synthetic).length},
    provenance:'Site notes, schedule estimates and costs are supplied planning assumptions. Fixture entries are synthetic.',
    siteFields:['name','type','fixture','feasibility','estimatedStart','estimatedReady','staffNotes','costSource','baseCostComponentsCents','replacement'],
    costOrder:costKeys,
    sites:orderedSites.map(site=>[site.name,site.categoryName,!!site.fixture,site.feasibility,site.estimatedStart??null,site.estimatedReady??null,
      site.notes,site.costs.source,costKeys.map(key=>site.costs[key]?.base??null),
      [site.costs.replacementPlan,site.costs.interval]]),
    evidence:'coverage: new demand, overlap. cost: base upfront cents, lifecycle cents, budget fit, cents per requester. checks: requirements, feasibility, gaps. s1, s2, s3: positions in the option’s sites list, which indexes the full sites array.',
    options:optionData,
  };
}
function safeText(value:string,limit:number) {
  return value===value.trim()&&value.length>0&&value.length<=limit&&!/[\p{Cc}]/u.test(value)
    &&value.split(/\s+/).length<=goalLimits.reasonWords;
}
export function parseGoalEvaluation(content:string,expected:Map<string,Set<string>>) {
  let data:unknown;
  try {data=JSON.parse(content);}catch {return {reason:'invalid_json'} as const;}
  const result=responseSchema.safeParse(data);
  if(!result.success)return {reason:'invalid_goal_shape'} as const;
  const clarification=result.data.clarification?.trim()??null;
  const assessments=result.data.assessments.map(row=>({...row,reason:row.reason.trim(),conflict:row.conflict?.trim()||null,
    evidence:[...new Set(row.evidence)],missing:row.missing.map(item=>item.trim())}));
  if(clarification!==null) {
    if(assessments.length||!safeText(clarification,goalLimits.reasonChars))return {reason:'invalid_goal_clarification'} as const;
  } else if(assessments.length!==expected.size||new Set(assessments.map(row=>row.id)).size!==expected.size) {
    return {reason:'incomplete_goal_assessment'} as const;
  }
  for(const row of assessments) {
    const allowed=expected.get(row.id);
    if(!allowed||row.evidence.length>goalLimits.evidence||
      row.evidence.some(key=>!allowed.has(key))||(row.fit!=='insufficient'&&!row.evidence.length)) {
      return {reason:'invalid_goal_evidence'} as const;
    }
    if(row.missing.length>goalLimits.missing||row.missing.some(item=>!safeText(item,goalLimits.missingChars))) {
      return {reason:'invalid_goal_missing_facts'} as const;
    }
    if(!safeText(row.reason,goalLimits.reasonChars)||(row.conflict!==null&&!safeText(row.conflict,goalLimits.reasonChars))) {
      return {reason:'invalid_goal_assessment_text'} as const;
    }
  }
  const stable={clarification,assessments:[...assessments].sort((a,b)=>a.id<b.id?-1:Number(a.id!==b.id))};
  return {explanation:stable,providerOutput:stable} as const;
}

export async function prepareGoalEvaluation(env:Env,result:Comparison,goal:Goal) {
  const snapshot=snapshotForGoal(result,goal);
  const expected=new Map(snapshot.options.map(option=>[option.id,new Set(goalEvidenceKeys(option.sites.length))]));
  const instructions=loadPrompt('evaluate-program-goal',{output_word_limit:goalLimits.reasonWords});
  const model=modelParameters(env);
  const limits=staffComparisonAI.goal;
  const requests=[];
  const overall={options:snapshot.options.length,maxNewlyCovered:Math.max(0,...snapshot.options.map(option=>option.coverage[0]))};
  for(let start=0;start<snapshot.options.length;start+=limits.batchOptions) {
    const options=snapshot.options.slice(start,start+limits.batchOptions);
    const used=[...new Set(options.flatMap(option=>option.sites))].sort((a,b)=>a-b);
    const localIndex=new Map(used.map((index,local)=>[index,local]));
    const batch={...snapshot,overall,sites:used.map(index=>snapshot.sites[index]),
      options:options.map(option=>({...option,sites:option.sites.map(index=>localIndex.get(index)),
        requirementDetails:option.requirementDetails.map(([code,index])=>[code,typeof index==='number'?localIndex.get(index):null])}))};
    const allowed=new Map(options.map(option=>[option.id,expected.get(option.id)!]));
    const payload={...model,input:[{role:'developer',content:instructions},{role:'user',content:JSON.stringify(batch)}],
      text:{format:{type:'json_schema',name:'program_goal_assessment',strict:true,schema:outputSchema(allowed)}}};
    const generation={store:false,service_tier:'default',max_output_tokens:limits.outputOverhead+options.length*limits.outputPerOption} as const;
    requests.push({payload,generation,size:{options:options.length,limits},parse:(text:string)=>parseGoalEvaluation(text,allowed)});
  }
  const key=await hash(JSON.stringify([rubricVersion,goal.id,goal.version,result.revision,result.testWorkspace??false,
    [...result.scenario.selected].sort(),requests]));
  return {requests,key,parse:(text:string)=>parseGoalEvaluation(text,expected)};
}
export type GoalReview={
  goal:Goal; evaluation:GoalEvaluation|null; evaluationKey:string|null; blocked:string|null;
};
export function goalEvaluationBlock(result:Comparison,goal:Goal) {
  if(goal.allowedTypes.length&&!goal.allowedTypes.includes(result.scenario.category))return 'The current comparison equipment type is outside this goal.';
  if(goal.description===structuredGoalDescription)return 'No AI evaluation is available for a requirements-only goal. Add a qualitative objective to evaluate it.';
  if(!result.options.length)return 'There are no options in this comparison to evaluate.';
  return null;
}
async function reviewGoalRequest(env:Env,result:Comparison,ref:GoalRef) {
  const goal=await currentGoal(env.DB,ref);
  await verifyAIContext(env.DB,result.revision,{goal:ref,testWorkspace:result.testWorkspace});
  const base:GoalReview={goal,evaluation:null,evaluationKey:null,blocked:null};
  const blocked=goalEvaluationBlock(result,goal);
  if(blocked)return {review:{...base,blocked}};
  if(!env.OPENAI_MODEL||!env.OPENAI_REASONING_EFFORT) {
    return {review:{...base,blocked:'AI is unavailable. Goal requirements are still applied.'}};
  }
  const request=await prepareGoalEvaluation(env,result,goal);
  const oversized=request.requests.map(inputSizeError).find(Boolean);
  if(oversized)return {review:{...base,blocked:oversized}};
  const record=await stmt(env.DB,'SELECT result FROM ai_jobs WHERE key=? AND expires>? AND result IS NOT NULL',
    request.key,Date.now()).first<string>('result');
  const evaluation=record?request.parse(record).explanation:null;
  return {review:{...base,evaluation:evaluation??null,evaluationKey:evaluation?request.key:null},request};
}
export async function goalReview(env:Env,result:Comparison,ref:GoalRef):Promise<GoalReview> {
  return (await reviewGoalRequest(env,result,ref)).review;
}
export async function evaluateGoal(env:Env,result:Comparison,ref:GoalRef,staffScope:string,requestId?:string):Promise<GoalReview> {
  const {review,request}=await reviewGoalRequest(env,result,ref);
  if(!request||review.evaluation)return review;
  const context:GenerationContext={goal:ref,staffScope,testWorkspace:result.testWorkspace,feature:'goal'};
  const evaluation=await generate<GoalEvaluation>(env,{...request,revision:result.revision,context,cacheMs:ai.cacheDays*86_400_000,
    merge:values=>{
      const clarification=values.find(value=>value.clarification)?.clarification??null;
      return {clarification,assessments:clarification?[]:values.flatMap(value=>value.assessments)};
    },
  },fetch,requestId);
  return {...review,evaluation:evaluation.value,evaluationKey:request.key};
}

export function goalExplanationContext(result:Comparison,review:GoalReview,filter:GoalFilter,order:GoalOrder) {
  const {goal,evaluation}=review;
  const rows=goalRows(result,goal,evaluation);
  const view=goalView(rows,filter,order);
  const [first,second]=view.visible;
  const positions=new Map(view.visible.map((row,index)=>[row.id,index+1]));
  const detailed=new Set(view.visible.slice(0,staffComparisonAI.explanation.detailOptions).map(row=>row.id));
  return {
    goal:{id:goal.id,version:goal.version,name:goal.name,description:goal.description,earliestStart:goal.earliestStart,targetCompletion:goal.targetCompletion,
      allowedTypes:goal.types.map(type=>type.name+(type.active?'':' (unavailable)'))},
    clarification:evaluation?.clarification??null, qualitativeFit:evaluation?'assessed':review.blocked??'not evaluated',
    filter:goalFilterLabels[filter],order:order==='fit'?'Goal fit':'Ordinary comparison',counts:view.counts,shown:view.shown,hidden:view.hidden,
    evaluationKey:review.evaluationKey,
    firstVisible:first?{id:first.id,basis:leadingGoalBasis(order,first,second),fit:fitLabels[first.fit]}:null,
    options:rows.map((row,index)=>({id:row.id,requirements:row.requirement,eligibility:row.eligibility,
      baselinePosition:index+1,visiblePosition:positions.get(row.id)??null,fit:row.fit,
      checks:[...new Set([...row.requirements,...row.eligibilityIssues].map(issue=>issue.code))],
      ...(detailed.has(row.id)&&row.assessment?{reason:row.assessment.reason,missing:row.assessment.missing,conflict:row.assessment.conflict}:{}),
    })),
  };
}

export function goalBrief(result:Comparison,review:GoalReview,filter:GoalFilter,order:GoalOrder) {
  const {goal,evaluation}=review;
  const rows=goalRows(result,goal,evaluation);
  const view=goalView(rows,filter,order);
  const shown=new Set(view.visible.map(row=>row.id));
  const names=new Map(result.sites.map(site=>[site.id,site.name]));
  const options=new Map(result.options.map(option=>[optionId(option.ids),option]));
  return [
    '## Program goal', '',
    `**${clean(goal.name)}** (version ${goal.version})`, clean(goal.description),
    `Earliest start: ${goal.earliestStart??'Unrestricted'} | Target completion: ${goal.targetCompletion??'Unrestricted'}`,
    `Allowed equipment: ${goal.types.map(type=>clean(type.name)+(type.active?'':' (unavailable)')).join(', ')||'All active types'}`,
    `Filter: ${goalFilterLabels[filter]} | Order: ${order==='fit'?'Goal fit':'Ordinary comparison'} | Shown: ${view.shown} | Hidden: ${view.hidden}`,
    Object.entries(view.counts).map(([bucket,count])=>`${count} ${bucketLabels[bucket as keyof typeof bucketLabels]}`).join(' · '),
    ...(evaluation?.clarification?[`Needs clarification: ${clean(evaluation.clarification)}`]:[]),
    ...(!evaluation?[review.blocked??'Qualitative fit has not been evaluated.']:[]), '',
    ...[...view.visible,...rows.filter(row=>!shown.has(row.id))].flatMap(row=>{
      const option=options.get(row.id);
      const assessment=row.assessment;
      return [`- ${option?.ids.map(id=>clean(names.get(id)??id)).join(' + ')} · ${shown.has(row.id)?'Shown':'Hidden'} · Requirements: ${statusLabels[row.requirement]} · Eligibility: ${statusLabels[row.eligibility]} · Goal fit: ${fitLabels[row.fit]}`,
        ...[...row.requirements,...row.eligibilityIssues].map(issue=>`  - ${goalReasonLabels[issue.code]}${issue.site?` · ${clean(names.get(issue.site)??issue.site)}`:''}`),
        ...(assessment?[`  - ${clean(assessment.reason)}`,
          ...assessment.evidence.map(key=>`  - Evidence: ${clean(evidenceLabels(result,row.id).get(key)??'')}`),
          ...assessment.missing.map(text=>`  - Missing: ${clean(text)}`),
          ...(assessment.conflict?[`  - Qualitative conflict: ${clean(assessment.conflict)}`]:[])]:[])];
    }),
    '', '### Baseline comparison figures', '',
  ];
}
