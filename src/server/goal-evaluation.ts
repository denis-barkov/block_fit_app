import { z } from 'zod';
import { goalLimits, structuredGoalDescription } from '../../config/goals';
import { ai } from '../../config/settings';
import { costKeys } from '../contracts';
import { bucketLabels, evidenceLabels, fitLabels, fits, goalFilterLabels, goalReasonLabels, goalRows, goalView, optionId, statusLabels, type Goal,
  type GoalEvaluation, type GoalFilter, type GoalOrder, type GoalRef } from '../goals';
import { generate, fitsInput, hash, modelParameters, verifyAIContext, type GenerationContext } from './ai-gateway';
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
  const citations=[...new Set([...expected.values()].flatMap(keys=>[...keys]))];
  const {$schema,...schema}=z.toJSONSchema(responseSchema.extend({
    clarification:text.nullable(),
    assessments:z.array(assessmentSchema.extend({
      id:z.enum([...expected.keys()]),evidence:z.array(z.enum(citations)).max(goalLimits.evidence),
      reason:text,conflict:text.nullable(),
      missing:z.array(z.string().min(1).max(goalLimits.missingChars)).max(goalLimits.missing),
    })).max(expected.size),
  }));
  return schema;
}
const generation={store:false,service_tier:'default',max_output_tokens:ai.outputTokens} as const;
const rubricVersion=1;

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
  const expected=new Map(snapshot.options.map(option=>[option.id,new Set(evidenceLabels(result,option.id).keys())]));
  const instructions=loadPrompt('evaluate-program-goal',{output_word_limit:goalLimits.reasonWords});
  const payload={...modelParameters(env),input:[{role:'developer',content:instructions},
    {role:'user',content:JSON.stringify(snapshot)}],
    text:{format:{type:'json_schema',name:'program_goal_assessment',strict:true,schema:outputSchema(expected)}}};
  const key=await hash(JSON.stringify([rubricVersion,goal.id,goal.version,result.revision,result.testWorkspace??false,
    [...result.scenario.selected].sort(),payload,generation,ai.inputTokens]));
  return {payload,generation,key,parse:(text:string)=>parseGoalEvaluation(text,expected)};
}
export type GoalReview={
  goal:Goal; evaluation:GoalEvaluation|null; evaluationKey:string|null; blocked:string|null;
};
export function goalEvaluationBlock(result:Comparison,goal:Goal) {
  if(goal.allowedTypes.length&&!goal.allowedTypes.includes(result.scenario.category))return 'The current comparison equipment type is outside this goal.';
  if(goal.description===structuredGoalDescription)return 'This goal uses equipment and date requirements only. No AI evaluation is needed.';
  if(!result.options.length)return 'There are no options in this comparison to evaluate.';
  if(result.options.length>goalLimits.options)return `Narrow the comparison to ${goalLimits.options} options or fewer before evaluating.`;
  return null;
}
export async function goalReview(env:Env,result:Comparison,ref:GoalRef):Promise<GoalReview> {
  const goal=await currentGoal(env.DB,ref);
  await verifyAIContext(env.DB,result.revision,{goal:ref,testWorkspace:result.testWorkspace});
  const base={goal,evaluation:null,evaluationKey:null};
  const blocked=goalEvaluationBlock(result,goal);
  if(blocked)return {...base,blocked};
  if(!env.OPENAI_MODEL||!env.OPENAI_REASONING_EFFORT)return {...base,blocked:'AI is unavailable. Goal requirements are still applied.'};
  const request=await prepareGoalEvaluation(env,result,goal);
  if(!fitsInput(request.payload))return {...base,blocked:'This goal assessment exceeds the input limit. Narrow the comparison.'};
  const record=await stmt(env.DB,'SELECT result FROM ai_jobs WHERE key=? AND expires>? AND result IS NOT NULL',
    request.key,Date.now()).first<string>('result');
  const evaluation=record?request.parse(record).explanation:null;
  return {goal,blocked:null,evaluation:evaluation??null,evaluationKey:evaluation?request.key:null};
}
export async function evaluateGoal(env:Env,result:Comparison,ref:GoalRef,staffScope:string,requestId?:string):Promise<GoalReview> {
  const review=await goalReview(env,result,ref);
  if(review.blocked||review.evaluation)return review;
  const request=await prepareGoalEvaluation(env,result,review.goal);
  const context:GenerationContext={goal:ref,staffScope,testWorkspace:result.testWorkspace,feature:'goal'};
  const evaluation=await generate(env,{...request,revision:result.revision,context,cacheMs:ai.cacheDays*86_400_000},fetch,requestId);
  return {...review,evaluation:evaluation.value,evaluationKey:request.key};
}

export function goalExplanationContext(result:Comparison,review:GoalReview,filter:GoalFilter,order:GoalOrder) {
  const {goal,evaluation}=review;
  const rows=goalRows(result,goal,evaluation);
  const view=goalView(rows,filter,order);
  return {
    goal:{id:goal.id,version:goal.version,name:goal.name,description:goal.description,earliestStart:goal.earliestStart,targetCompletion:goal.targetCompletion,
      allowedTypes:goal.types.map(type=>type.name+(type.active?'':' (unavailable)'))},
    clarification:evaluation?.clarification??null, qualitativeFit:evaluation?'assessed':review.blocked??'not evaluated',
    filter:goalFilterLabels[filter],order:order==='fit'?'Goal fit':'Ordinary comparison',counts:view.counts,shown:view.shown,hidden:view.hidden,
    baselineOrder:rows.map(row=>row.id),visibleOrder:view.visible.map(row=>row.id),
    options:rows.map(row=>({id:row.id,requirements:row.requirement,eligibility:row.eligibility,
      checks:[...new Set([...row.requirements,...row.eligibilityIssues].map(issue=>issue.code))],
      fit:row.fit,reason:row.assessment?.reason,missing:row.assessment?.missing,conflict:row.assessment?.conflict})),
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
