import { Pencil, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { goalLimits, structuredGoalDescription } from '../../config/goals';
import type { EquipmentType } from '../contracts';
import { bucketLabels, evidenceLabels, fitLabels, goalBuckets, goalFilterLabels, goalReasonLabels, statusLabels,
  type Goal, type GoalComparison, type GoalFilter, type GoalInput, type GoalOrder, type GoalRow } from '../goals';
import type { GoalReview } from '../server/goal-evaluation';
import { api, Feedback, Field, InfoHint, message, Modal, useAction } from './common';

export function useProgramGoals() {
  const [goals,setGoals]=useState<Goal[]>();
  const [error,setError]=useState('');
  const [selected,select]=useState('');
  const sequence=useRef(0);
  async function refresh() {
    const call=++sequence.current;
    try {
      const next=await api<Goal[]>('/staff/goals');
      if(call===sequence.current) {setGoals(next);setError('');}
      return next;
    } catch(error) {
      if(call===sequence.current)setError(message(error));
      return undefined;
    }
  }
  useEffect(()=>{
    const update=()=>void refresh();
    update();window.addEventListener('focus',update);
    return ()=>window.removeEventListener('focus',update);
  },[]);
  return {goals,error,selected,select,goal:goals?.find(goal=>goal.id===selected),refresh};
}

type Ref={scenario:GoalComparison['scenario'];revision:number;calculatedAt:string};
type ReviewState={key:string;pending:boolean;evaluating?:boolean;error?:string;review?:GoalReview};
export function useGoalReview(goal:Goal|undefined,reference:Ref|null) {
  const [state,setState]=useState<ReviewState>();
  const key=goal&&reference?JSON.stringify([reference,goal.id,goal.version]):'';
  const active=useRef(key);
  active.current=key;
  const sequence=useRef(0);
  const status=state?.key===key?state:undefined;
  async function submit(evaluate:boolean) {
    if(!goal||!reference)return;
    const request=++sequence.current;
    setState(value=>({key,pending:true,evaluating:evaluate,review:evaluate?undefined:value?.key===key?value.review:undefined}));
    try {
      const review=await api<GoalReview>(`/staff/goals/${evaluate?'evaluate':'preview'}`,'POST',
        {...reference,goal:{id:goal.id,version:goal.version}});
      if(active.current===key&&sequence.current===request)setState({key,pending:false,review});
    } catch(error) {
      if(active.current===key&&sequence.current===request)setState({key,pending:false,error:message(error)});
    }
  }
  useEffect(()=>{if(key)void submit(false);},[key]);
  useEffect(()=>{
    if(!key||status?.pending)return;
    const update=()=>void submit(false);
    window.addEventListener('focus',update);
    return ()=>window.removeEventListener('focus',update);
  },[key,status?.pending]);
  return {status,submit};
}

type Programs=ReturnType<typeof useProgramGoals>;
export function GoalSelector({programs,types,onSelect}: {programs:Programs;types:EquipmentType[];onSelect:(id:string)=>void}) {
  const [editing,edit]=useState(false);
  const opener=useRef<HTMLButtonElement>(null);
  return <div className="space-y-2">
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-45 flex-1 max-w-sm"><Field label="Program goal"><select value={programs.selected}
        disabled={!programs.goals} onChange={event=>onSelect(event.target.value)}>
        <option value="">No goal</option>
        {programs.selected&&!programs.goal&&<option value={programs.selected} disabled>Goal unavailable</option>}
        {programs.goals?.map(goal=><option value={goal.id} key={goal.id}>{goal.name}</option>)}
      </select></Field></div>
      <button ref={opener} type="button" className="button gap-2" onClick={()=>edit(true)}>
        <Pencil className="action-icon" aria-hidden="true"/> Manage goals
      </button>
      {programs.selected&&<button type="button" className="button" onClick={()=>onSelect('')}>Clear goal</button>}
    </div>
    {!programs.goals&&!programs.error&&<p role="status" className="text-sm muted">Loading saved goals…</p>}
    <Feedback error={programs.error}/>
    {programs.error&&<button type="button" className="button" onClick={()=>void programs.refresh()}>Retry goals</button>}
    {programs.selected&&!programs.goal&&<p role="status">This goal has been deleted or is unavailable. Clear it to return to ordinary comparison.</p>}
    {editing&&<ManageGoals programs={programs} types={types} onSelect={onSelect}
      close={()=>{edit(false);requestAnimationFrame(()=>opener.current?.focus());}}/>}
  </div>;
}

const blank:GoalInput={name:'',description:'',earliestStart:null,targetCompletion:null,allowedTypes:[]};
function formFields(goal?:Goal):GoalInput {
  if(!goal)return blank;
  const {name,description,earliestStart,targetCompletion,allowedTypes}=goal;
  return {name,description,earliestStart,targetCompletion,allowedTypes};
}
function ManageGoals({programs,types,onSelect,close}: {programs:Programs;types:EquipmentType[];onSelect:(id:string)=>void;close:()=>void}) {
  const [editing,setEditing]=useState(programs.goal);
  const [form,setForm]=useState(()=>formFields(editing));
  const [query,setQuery]=useState('');
  const [confirm,setConfirm]=useState<null|'leave'|'delete'>(null);
  const action=useAction();
  const dirty=JSON.stringify(form)!==JSON.stringify(formFields(editing));
  const picked=new Set(form.allowedTypes);
  const available=[...types,...(editing?.types.filter(type=>!types.some(item=>item.id===type.id))??[])];
  const matches=available.filter(type=>picked.has(type.id)||type.name.toLowerCase().includes(query.trim().toLowerCase()));
  const field=<K extends keyof GoalInput>(key:K,value:GoalInput[K])=>setForm(previous=>({...previous,[key]:value}));
  useEffect(()=>{
    if(!dirty)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);
    return ()=>window.removeEventListener('beforeunload',warn);
  },[dirty]);
  function choose(goal?:Goal) {
    if(dirty) {setConfirm('leave');return;}
    setEditing(goal);setForm(formFields(goal));setQuery('');
  }
  function cancel() {
    if(action.busy)return;
    if(confirm)setConfirm(null);
    else if(dirty)setConfirm('leave');
    else close();
  }
  return <Modal title="Manage program goals" onClose={cancel}
    help={{label:'About saved goals',content:<p>Goals are shared with staff. Your active goal is selected for this view. Dates are planning requirements and use calendar dates.</p>}}>
    <form className="space-y-3" onSubmit={event=>{
      event.preventDefault();
      void action.run(async()=>{
        const saved=await api<{id:string;version:number}>(editing?`/staff/goals/${editing.id}`:'/staff/goals',editing?'PUT':'POST',
          editing?{...form,version:editing.version}:form);
        await programs.refresh();onSelect(saved.id);close();
      });
    }}>
      {programs.goals?.length?<Field label="Goal to edit"><select value={editing?.id??''}
        onChange={event=>choose(programs.goals?.find(goal=>goal.id===event.target.value))}>
        <option value="">Create a goal</option>{programs.goals.map(goal=><option key={goal.id} value={goal.id}>{goal.name}</option>)}
        {editing&&!programs.goals.some(goal=>goal.id===editing.id)&&<option value={editing.id} disabled>Goal unavailable</option>}
      </select></Field>:<p className="text-sm muted">Create a shared goal to start comparing options against it.</p>}
      {confirm==='leave'&&<div className="rounded-control bg-warning p-3 space-y-2" role="alert">
        <p>You have unsaved changes. Discard them and close this editor?</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="button" onClick={()=>setConfirm(null)}>Keep editing</button>
          <button type="button" className="button" onClick={close}>Discard changes</button></div>
      </div>}
      <Field label="Short name"><input value={form.name} required maxLength={goalLimits.name} onChange={event=>field('name',event.target.value)}/></Field>
      <Field label="Description"><textarea value={form.description} required maxLength={goalLimits.description}
        onChange={event=>field('description',event.target.value)}/></Field>
      <button type="button" className="text-sm font-bold underline" onClick={()=>field('description',structuredGoalDescription)}>
        Use equipment and dates only
      </button>
      <div className="field-grid">
        <Field label="Earliest project start (optional)"><input type="date" value={form.earliestStart??''}
          onChange={event=>field('earliestStart',event.target.value||null)}/></Field>
        <Field label="Target completion (optional)"><input type="date" value={form.targetCompletion??''}
          onChange={event=>field('targetCompletion',event.target.value||null)}/></Field>
      </div>
      <fieldset className="min-w-0 space-y-2">
        <legend className="font-bold">Allowed equipment types</legend>
        <p className="text-sm muted">{picked.size?`${picked.size} selected`:'All active types allowed'}</p>
        <Field label="Search equipment types"><input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></Field>
        <div className="max-h-40 overflow-auto space-y-2">{matches.map(type=><label key={type.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={picked.has(type.id)} disabled={!type.active&&!picked.has(type.id)}
            onChange={event=>field('allowedTypes',event.target.checked?[...picked,type.id]:[...picked].filter(id=>id!==type.id))}/>
          <span className="break-words">{type.name}{!type.active?' (unavailable)':''}</span>
        </label>)}</div>
        {!matches.length&&<p className="text-sm muted">No matching equipment types.</p>}
        {available.some(type=>picked.has(type.id)&&!type.active)&&<p className="text-sm font-semibold">
          Review unavailable types. Removing every restriction allows all active types.
        </p>}
      </fieldset>
      {confirm==='delete'&&<div className="rounded-control bg-warning p-3 space-y-2" role="alert">
        <p>Delete this shared goal? Staff will no longer be able to select it.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className="button" onClick={()=>setConfirm(null)}>Keep goal</button>
          <button type="button" className="button" disabled={action.busy} onClick={()=>editing&&void action.run(async()=>{
            await api(`/staff/goals/${editing.id}`,'DELETE',{version:editing.version});
            await programs.refresh();if(programs.selected===editing.id)onSelect('');close();
          })}>Confirm deletion</button></div>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button className="button primary" disabled={action.busy}>Save goal</button>
        {editing&&<button type="button" className="button" disabled={action.busy} onClick={()=>setConfirm('delete')}>Delete goal</button>}
      </div>
      <Feedback error={action.error}/>
    </form>
  </Modal>;
}

export function GoalStatus({goal,review,view,filter,order,budget,disabled,onFilter,onOrder,evaluate}: {
  goal:Goal;review:ReviewState|undefined;view:{counts:Record<typeof goalBuckets[number],number>;shown:number;hidden:number};
  filter:GoalFilter;order:GoalOrder;budget:string;disabled:boolean;
  onFilter:(filter:GoalFilter)=>void;onOrder:(order:GoalOrder)=>void;evaluate:()=>void;
}) {
  return <section className="rounded-control border border-line bg-canvas p-3 space-y-3" aria-label="Goal review">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="break-words">{goal.name}</h3>
        <p className="text-sm muted break-words">
          Upfront budget {budget} · {goal.types.length?goal.types.map(type=>type.name+(type.active?'':' (unavailable)')).join(', '):'All active equipment types'}
          {goal.earliestStart&&<> · Start on or after <time className="whitespace-nowrap" dateTime={goal.earliestStart}>{goal.earliestStart}</time></>}
          {goal.targetCompletion&&<> · Ready by <time className="whitespace-nowrap" dateTime={goal.targetCompletion}>{goal.targetCompletion}</time></>}
        </p>
      </div>
      <button className="button primary gap-2" type="button" disabled={disabled||!review||review.pending||!!review.review?.blocked}
        onClick={evaluate}><Sparkles className="action-icon" aria-hidden="true"/>
        {review?.evaluating?'Evaluating goal…':review?.pending?'Checking goal…':'Evaluate goal'}</button>
    </div>
    {review?.evaluating&&<p className="sr-only" role="status">Evaluating goal…</p>}
    {review?.review?.blocked&&<p className="text-sm font-semibold" role="status">{review.review.blocked}</p>}
    {review?.review?.evaluation?.clarification&&<p className="text-sm" role="status">
      <strong>Needs clarification.</strong> {review.review.evaluation.clarification}
    </p>}
    {review?.error&&<Feedback error={`Goal evaluation unavailable. ${review.error}`}/>}
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Filter by goal fit"><select value={filter} onChange={event=>onFilter(event.target.value as GoalFilter)}>
        {Object.entries(goalFilterLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></Field>
      <Field label="Option ordering"><select value={order} onChange={event=>onOrder(event.target.value as GoalOrder)}>
        <option value="baseline">Ordinary comparison</option><option value="fit">Goal fit</option>
      </select></Field>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {goalBuckets.filter(key=>view.counts[key]>0).map(key=><button key={key} className="button" type="button"
        aria-pressed={filter===key} onClick={()=>onFilter(filter===key?'all':key)}>{view.counts[key]} {bucketLabels[key]}</button>)}
      <InfoHint label="What goal status counts mean" content={<p>Each option counts once. A failed requirement or eligibility check puts it in Excluded. Unknown checks or insufficient evidence need information. A match is eligible and has Strong or Partial fit.</p>}>
        <span className="text-sm font-semibold">{view.shown} shown · {view.hidden} hidden</span>
      </InfoHint>
    </div>
  </section>;
}

export function GoalFitCell({row,comparison,label}: {row:GoalRow;comparison:GoalComparison;label:string}) {
  const assessed=row.assessment;
  const issues=[...row.requirements,...row.eligibilityIssues];
  const names=new Map(comparison.sites.map(site=>[site.id,site.name]));
  const evidence=assessed?evidenceLabels(comparison,row.id):null;
  return <td>
    {assessed||issues.length?<InfoHint label={`Goal evidence for ${label}`} content={<>
      {assessed&&<p>{assessed.reason}</p>}
      {assessed?.evidence.map(key=><p key={key}>Evidence · {evidence?.get(key)}</p>)}
      {assessed?.missing.map((text,index)=><p key={index}>Missing · {text}</p>)}
      {assessed?.conflict&&<p>Qualitative conflict · {assessed.conflict}</p>}
      {issues.map(issue=><p key={issue.code+(issue.site??'')}>{goalReasonLabels[issue.code]}{issue.site&&` · ${names.get(issue.site)}`}</p>)}
    </>}><span className="font-bold">{fitLabels[row.fit]}</span></InfoHint>:<p>{fitLabels[row.fit]}</p>}
    <p className="text-xs muted">Requirements · {statusLabels[row.requirement]}</p>
    <p className="text-xs muted">Eligibility · {statusLabels[row.eligibility]}</p>
  </td>;
}
