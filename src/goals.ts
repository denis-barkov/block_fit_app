import { z } from 'zod';
import { goalLimits } from '../config/goals.ts';
import { category, optionalDate, scenarioInput } from './contracts.ts';
import type { Comparison } from './server/planning';

const orderedDates=(start:string|null|undefined,end:string|null|undefined)=>!start||!end||start<=end;
export const goalInput=z.object({
  name:z.string().trim().min(1).max(goalLimits.name).refine(value=>!/[\p{Cc}]/u.test(value),'Enter a single-line name.'),
  description:z.string().trim().min(1).max(goalLimits.description),
  earliestStart:optionalDate,targetCompletion:optionalDate,
  allowedTypes:z.array(category).max(goalLimits.allowedTypes).refine(ids=>new Set(ids).size===ids.length,'Choose each type once.'),
}).strict();
export const goalDates=(goal:Pick<GoalInput,'earliestStart'|'targetCompletion'>)=>orderedDates(goal.earliestStart,goal.targetCompletion);
export type GoalInput=z.infer<typeof goalInput>;
export const goalRef=z.object({id:z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),version:z.number().int().positive()}).strict();
export type GoalRef=z.infer<typeof goalRef>;
export type Goal=GoalInput&GoalRef&{
  createdAt:string;updatedAt:string;types:{id:string;name:string;description:string;active:boolean}[];
};

export const filters=['all','good','strong','excluded','information','pending','match','weak'] as const;
export type GoalFilter=typeof filters[number];
export const goalFilterLabels:Record<GoalFilter,string>={all:'All options',good:'Strong or partial fit',strong:'Strong fit only',
  excluded:'Excluded options',information:'Needs information',pending:'Not evaluated',match:'Matching options',weak:'Low fit'};
export const goalOrder=z.enum(['baseline','fit']);
export type GoalOrder=z.infer<typeof goalOrder>;
export const goalViewInput=goalRef.extend({filter:z.enum(filters),order:goalOrder,
  evaluationKey:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
export const comparisonRef=z.object({
  scenario:scenarioInput,revision:z.number().int().nonnegative(),calculatedAt:z.iso.datetime(),
}).strict();
export const goalComparisonRef=comparisonRef.extend({goal:goalRef}).strict();

export const fits=['strong','partial','weak','insufficient'] as const;
export type Fit=typeof fits[number];
export const fitLabels={strong:'Strong',partial:'Partial',weak:'Weak',insufficient:'Insufficient evidence',pending:'Not evaluated'};
export const statusLabels={meets:'Meets',fails:'Does not meet',unknown:'Unknown'};
export const goalReasonLabels={
  equipment:'Equipment type outside the goal',early:'Estimated start before earliest start',
  late:'Estimated ready date after target',start:'Estimated start date missing',ready:'Estimated ready date missing',
  budget:'Base upfront cost exceeds budget',upfront:'Base upfront cost is unknown',lifecycle:'Lifecycle cost is incomplete',
  excluded:'Site excluded from comparison eligibility',review:'Feasibility is unreviewed',
} as const;
type Reason=keyof typeof goalReasonLabels;
type Issue={code:Reason;site?:string};
type Status=keyof typeof statusLabels;
export type GoalAssessment={id:string;fit:Fit;reason:string;evidence:string[];missing:string[];conflict:string|null};
export type GoalEvaluation={clarification:string|null;assessments:GoalAssessment[]};
export type GoalRow={
  id:string;requirement:Status;eligibility:Status;requirements:Issue[];eligibilityIssues:Issue[];
  assessment?:GoalAssessment;fit:Fit|'pending';bucket:GoalBucket;
};
export type GoalComparison=Pick<Comparison,'sites'|'options'|'scenario'>;
export const goalBuckets=['match','excluded','information','pending','weak'] as const;
export type GoalBucket=typeof goalBuckets[number];
export const bucketLabels={match:'match',excluded:'excluded',information:'need information',pending:'not evaluated',weak:'low fit'};
export const optionId=(ids:string[])=>[...ids].sort().join(',');
const status=(failed:boolean,unknown:boolean):Status=>failed?'fails':unknown?'unknown':'meets';
const bucket=(requirement:Status,eligibility:Status,fit:GoalRow['fit'],clarification:boolean):GoalBucket=>{
  if(requirement==='fails'||eligibility==='fails')return 'excluded';
  if(requirement==='unknown'||eligibility==='unknown'||clarification||fit==='insufficient')return 'information';
  return fit==='pending'?'pending':fit==='weak'?'weak':'match';
};

export function goalRows(comparison:GoalComparison,goal:GoalInput,evaluation?:GoalEvaluation|null) {
  const sites=new Map(comparison.sites.map(site=>[site.id,site]));
  const assessments=new Map(evaluation?.assessments.map(row=>[row.id,row]));
  return comparison.options.map(option=>{
    const id=optionId(option.ids);
    const requirements:Issue[]=[];
    const eligibilityIssues:Issue[]=[];
    for(const siteId of option.ids) {
      const site=sites.get(siteId);
      if(!site)continue;
      if(goal.allowedTypes.length&&!goal.allowedTypes.includes(site.category))requirements.push({code:'equipment',site:site.id});
      if(goal.earliestStart) {
        if(!site.estimatedStart)requirements.push({code:'start',site:site.id});
        else if(site.estimatedStart<goal.earliestStart)requirements.push({code:'early',site:site.id});
      }
      if(goal.targetCompletion) {
        if(!site.estimatedReady)requirements.push({code:'ready',site:site.id});
        else if(site.estimatedReady>goal.targetCompletion)requirements.push({code:'late',site:site.id});
      }
    }
    const base=option.estimates.base;
    if(base.fits===false)eligibilityIssues.push({code:'budget'});
    if(base.fits===null)eligibilityIssues.push({code:'upfront'});
    if(base.lifecycle===null)eligibilityIssues.push({code:'lifecycle'});
    if(option.feasibility==='excluded')eligibilityIssues.push({code:'excluded'});
    if(option.feasibility==='unreviewed')eligibilityIssues.push({code:'review'});
    const requirement=status(requirements.some(({code})=>code==='equipment'||code==='early'||code==='late'),requirements.length>0);
    const eligibility=status(eligibilityIssues.some(({code})=>code==='budget'||code==='excluded'),eligibilityIssues.length>0);
    const assessment=assessments.get(id);
    const fit=assessment?.fit??'pending';
    return {id,requirement,eligibility,requirements,eligibilityIssues,assessment,fit,
      bucket:bucket(requirement,eligibility,fit,!!evaluation?.clarification)} satisfies GoalRow;
  });
}
const fitOrder={strong:0,partial:1,weak:2,insufficient:3,pending:3};
const qualityGroup=(row:GoalRow)=>row.bucket==='excluded'?2:
  row.requirement==='unknown'||row.eligibility==='unknown'?1:0;

export function goalView(rows:GoalRow[],filter:GoalFilter,order:GoalOrder) {
  const counts={match:0,excluded:0,information:0,pending:0,weak:0};
  for(const row of rows)counts[row.bucket]++;
  const selected=rows.filter(row=>filter==='all'||(filter==='good'&&row.bucket==='match')||
    (filter==='strong'&&row.bucket==='match'&&row.fit==='strong')||row.bucket===filter);
  const visible=order==='fit'?selected.map((row,index)=>({row,index})).sort((a,b)=>
    qualityGroup(a.row)-qualityGroup(b.row)||fitOrder[a.row.fit]-fitOrder[b.row.fit]||
    a.index-b.index||(a.row.id<b.row.id?-1:Number(a.row.id!==b.row.id))).map(({row})=>row):selected;
  return {counts,visible,shown:visible.length,hidden:rows.length-visible.length};
}

export function evidenceLabels(comparison:GoalComparison,id:string) {
  const option=comparison.options.find(option=>optionId(option.ids)===id);
  const names=new Map(comparison.sites.map(site=>[site.id,
    `${site.name} · ${site.fixture?'illustrative fixture':'staff planning assumptions'}`]));
  return new Map([['coverage','Recorded demand coverage'],['cost','Modeled costs and budget'],['checks','Feasibility and goal requirements'],
    ...(option?[...option.ids].sort().map((id,index)=>[`s${index+1}`,names.get(id)??'Candidate evidence'] as const):[])]);
}
