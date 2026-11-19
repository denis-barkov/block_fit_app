import { Check, Pencil, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { catalogLimits } from '../../config/settings';
import { matchingTypes, typeName, typeNameKey, type EquipmentType, type StaffEquipmentType, type TypeProposal } from '../contracts';
import { api, Categories, Feedback, Field, InfoHint, message, Modal, useAction } from './common';

type Page<T>={items:T[];next:number|null};
type Decision='create'|'match'|'reject';
type QueueItem=TypeProposal&{categoryName:string|null;reason:string|null;decidedAt:string|null};
type Editor={kind:'edit';type?:StaffEquipmentType}|{kind:'availability';type:StaffEquipmentType};
type TypeChanges={name:string;description:string;active?:boolean;version?:number;labelCorrection?:true};

function usePage<T>(path:string) {
  const [result,setResult]=useState<Page<T>>();
  const [error,setError]=useState('');
  const [refresh,reload]=useState(0);
  useEffect(()=>{
    let current=true;
    setResult(undefined);setError('');
    void api<Page<T>>(path).then(result=>{if(current)setResult(result);})
      .catch(error=>{if(current)setError(message(error));});
    return ()=>{current=false;};
  },[path,refresh]);
  return {result,error,reload:()=>reload(value=>value+1)};
}

const statusLabels={pending:'Awaiting type review',approved:'Approved',rejected:'Rejected',withdrawn:'Withdrawn'};

export default function CityCatalog({types,refreshTypes}: {types:EquipmentType[];refreshTypes:()=>Promise<void>}) {
  const [tab,setTab]=useState<'types'|'proposals'>('types');
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">City workspace</p><h1>Equipment types</h1></header>
    <div className="flex flex-wrap gap-2" aria-label="Equipment catalog sections">
      <button className={`button ${tab==='types'?'primary':''}`} aria-pressed={tab==='types'} onClick={()=>setTab('types')}>Types</button>
      <button className={`button ${tab==='proposals'?'primary':''}`} aria-pressed={tab==='proposals'} onClick={()=>setTab('proposals')}>Proposals</button>
    </div>
    {tab==='types'?<Types types={types} refreshTypes={refreshTypes}/>:<Proposals types={types} refreshTypes={refreshTypes}/>}
  </main>;
}

function TypePageControls({offset,next,change}: {offset:number;next:number|null;change:(offset:number)=>void}) {
  return (offset>0||next!==null) && <div className="flex flex-wrap gap-2">
    {offset>0 && <button className="button" onClick={()=>change(Math.max(0,offset-catalogLimits.page))}>Previous page</button>}
    {next!==null && <button className="button" onClick={()=>change(next)}>Next page</button>}
  </div>;
}

function Types({types,refreshTypes}: {types:EquipmentType[];refreshTypes:()=>Promise<void>}) {
  const [q,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [offset,setOffset]=useState(0);
  const [editor,setEditor]=useState<Editor|null>(null);
  const [notice,setNotice]=useState('');
  const {result,error,reload}=usePage<StaffEquipmentType>('/staff/types?'+new URLSearchParams({q,status,offset:String(offset)}));
  async function save(data:TypeChanges,type?:StaffEquipmentType) {
    await api(type?`/staff/types/${type.id}`:'/staff/types',type?'PUT':'POST',data);
    setEditor(null);
    setNotice(type?'Equipment type updated.':'Equipment type added.');
    reload();
    await refreshTypes();
  }
  return <section className="panel space-y-4" aria-labelledby="catalog-heading">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <InfoHint label="About equipment types" content={<p>A type classifies equipment and demand. Creating a type does not add installed equipment or approve an investment.</p>}>
        <h2 id="catalog-heading">Catalog</h2>
      </InfoHint>
      <button className="button primary gap-2" onClick={()=>setEditor({kind:'edit'})}>
        <Plus className="action-icon" aria-hidden="true"/> Add type
      </button>
    </div>
    <div className="field-grid">
      <Field label="Search types"><input type="search" maxLength={catalogLimits.nameMax} value={q}
        onChange={event=>{setQuery(event.target.value);setOffset(0);}}/></Field>
      <Field label="Type status"><select value={status} onChange={event=>{setStatus(event.target.value);setOffset(0);}}>
        <option value="all">All types</option><option value="active">Active</option><option value="inactive">Inactive</option>
      </select></Field>
    </div>
    <Feedback error={error} status={notice}/>
    {error && <button className="button" onClick={reload}>Retry catalog</button>}
    {!error&&!result && <p role="status">Loading equipment types…</p>}
    {result && <>
      {!result.items.length && <p>No equipment types match these filters.</p>}
      <ul className="divide-y divide-line">{result.items.map(type=><li key={type.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
        <div className="min-w-0">
          <h3 className="break-words">{type.name} <span className={`tag ${type.active?'':'unverified'}`}>{type.active?'Active':'Inactive'}</span></h3>
          {type.description && <p className="text-sm muted break-words">{type.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="button gap-2" onClick={()=>setEditor({kind:'edit',type})}>
            <Pencil className="action-icon" aria-hidden="true"/> Edit<span className="sr-only"> {type.name}</span>
          </button>
          <button className="button" onClick={()=>setEditor({kind:'availability',type})}>
            {type.active?'Deactivate':'Reactivate'}<span className="sr-only"> {type.name}</span>
          </button>
        </div>
      </li>)}</ul>
      <TypePageControls offset={offset} next={result.next} change={setOffset}/>
    </>}
    {editor?.kind==='edit' && <TypeDialog type={editor.type} types={types} close={()=>setEditor(null)} save={save}/>}
    {editor?.kind==='availability' && <AvailabilityDialog type={editor.type} close={()=>setEditor(null)} save={save}/>}
  </section>;
}

type SaveType=(data:TypeChanges,type?:StaffEquipmentType)=>Promise<void>;
function TypeDialog({type,types,close,save}: {type?:StaffEquipmentType;types:EquipmentType[];close:()=>void;save:SaveType}) {
  const [name,setName]=useState(type?.name??'');
  const [description,setDescription]=useState(type?.description??'');
  const [nearby,setNearby]=useState<StaffEquipmentType[]>([]);
  const [labelCorrection,setLabelCorrection]=useState(false);
  const action=useAction();
  const key=typeNameKey(name);
  useEffect(()=>{
    let current=true;
    setNearby([]);
    if(key.length>=catalogLimits.nameMin) {
      const timer=setTimeout(()=>void api<Page<StaffEquipmentType>>('/staff/types?'+new URLSearchParams({q:name.trim()}))
        .then(value=>{if(current)setNearby(value.items.filter(item=>item.id!==type?.id).slice(0,catalogLimits.matches));}).catch(()=>{}),200);
      return ()=>{current=false;clearTimeout(timer);};
    }
  },[name,key,type?.id]);
  const matches=nearby.length?nearby:matchingTypes(types,name,type?.id);
  const duplicate=matches.some(item=>typeNameKey(item.name)===key);
  const parsed=typeName.safeParse(name);
  const renaming=!!type&&parsed.success&&parsed.data!==type.name;
  return <Modal title={type?'Edit equipment type':'Add equipment type'} onClose={()=>{if(!action.busy)close();}}>
    <form className="space-y-3" onSubmit={event=>{
      event.preventDefault();
      void action.run(()=>save({name,description,...(type?{active:type.active,version:type.version}:{}),
        ...(renaming&&labelCorrection?{labelCorrection:true as const}:{})},type));
    }}>
      <Field label="Type name"><input required minLength={catalogLimits.nameMin} maxLength={catalogLimits.nameMax}
        value={name} onChange={event=>{setName(event.target.value);setLabelCorrection(false);}}/></Field>
      <Field label="Description (optional)"><textarea maxLength={catalogLimits.description}
        value={description} onChange={event=>setDescription(event.target.value)}/></Field>
      {type && <p className="text-sm muted">Use renaming for spelling or label corrections. Create a new type for a different kind of equipment.</p>}
      {renaming && <label className="flex items-center gap-2 text-sm"><input type="checkbox" required checked={labelCorrection}
        onChange={event=>setLabelCorrection(event.target.checked)}/> This corrects the label for the same kind of equipment.</label>}
      {!!matches.length && <div className="text-sm muted"><p className="font-semibold">Catalog matches</p>
        <ul>{matches.map(match=><li className="break-words" key={match.id}>{match.name}{!match.active&&' (inactive)'}</li>)}</ul></div>}
      {duplicate && <p role="status">That name already exists. Use the existing type or reactivate it if needed.</p>}
      <button className="button primary" disabled={action.busy||duplicate}>{type?'Save changes':'Create type'}</button>
      <Feedback error={action.error}/>
    </form>
  </Modal>;
}

function AvailabilityDialog({type,close,save}: {type:StaffEquipmentType;close:()=>void;save:SaveType}) {
  const action=useAction();
  const verb=type.active?'Deactivate':'Reactivate';
  return <Modal title={`${verb} equipment type?`} onClose={()=>{if(!action.busy)close();}}>
    <div className="space-y-3">
      <p className="break-words"><strong>{type.name}</strong></p>
      <p>{type.active?'People can no longer select this type for new requests, equipment, candidates, or proposal approvals. Existing records remain. Planning and travel suggestions stop using this type.'
        :'The type will be available to select again under the same ID. Prior requests keep their dates and statuses.'}</p>
      <button className="button primary" disabled={action.busy} onClick={()=>void action.run(()=>save({
        name:type.name,description:type.description,active:!type.active,version:type.version,
      },type))}>Confirm {type.active?'deactivation':'reactivation'}</button>
      <Feedback error={action.error}/>
    </div>
  </Modal>;
}

function Proposals({types,refreshTypes}: {types:EquipmentType[];refreshTypes:()=>Promise<void>}) {
  const [status,setStatus]=useState<TypeProposal['status']>('pending');
  const [offset,setOffset]=useState(0);
  const [selected,select]=useState<QueueItem>();
  const [notice,setNotice]=useState('');
  const {result,error,reload}=usePage<QueueItem>('/staff/proposals?'+new URLSearchParams({status,offset:String(offset)}));
  return <section className="panel space-y-4" aria-labelledby="proposals-heading">
    <InfoHint label="About type review" content={<p>Reviewing a proposal changes the resident’s request status. Installation, feasibility and funding are separate decisions.</p>}>
      <h2 id="proposals-heading">Resident proposals</h2>
    </InfoHint>
    <Field label="Proposal status"><select value={status} onChange={event=>{setStatus(event.target.value as typeof status);setOffset(0);}}>
      {Object.entries(statusLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </select></Field>
    <Feedback error={error} status={notice}/>
    {error && <button className="button" onClick={reload}>Retry proposals</button>}
    {!error&&!result && <p role="status">Loading proposals…</p>}
    {result && <>
      {!result.items.length && <p>No proposals with this status.</p>}
      <ul className="divide-y divide-line">{result.items.map(proposal=>{
        const matches=matchingTypes(types,proposal.name);
        return <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0">
            <h3 className="break-words">{proposal.name} <span className="tag">{statusLabels[proposal.status]}</span></h3>
            <p className="text-sm muted">Submitted {new Date(proposal.submittedAt).toLocaleDateString()}</p>
            {proposal.description && <p className="break-words">{proposal.description}</p>}
            {proposal.categoryName && <p className="text-sm muted break-words">Approved as {proposal.categoryName}</p>}
            {proposal.reason && <p className="text-sm muted break-words">{proposal.reason}</p>}
            {proposal.status==='pending' && !!matches.length && <p className="text-sm muted break-words">Possible matches {matches.map(type=>type.name).join(', ')}</p>}
          </div>
          {proposal.status==='pending' && <button className="button gap-2" onClick={()=>select(proposal)}>
            <Check className="action-icon" aria-hidden="true"/> Review<span className="sr-only"> {proposal.name}</span>
          </button>}
        </li>;
      })}</ul>
      <TypePageControls offset={offset} next={result.next} change={setOffset}/>
    </>}
    {selected && <DecisionDialog proposal={selected} types={types} close={()=>select(undefined)} save={async input=>{
      await api(`/staff/proposals/${selected.id}/decision`,'POST',input);
      select(undefined);setNotice('Review decision saved.');reload();
      await refreshTypes();
    }}/>}
  </section>;
}

function DecisionDialog({proposal,types,close,save}: {
  proposal:QueueItem;types:EquipmentType[];close:()=>void;save:(input:object)=>Promise<void>;
}) {
  const [decision,setDecision]=useState<Decision>('create');
  const [name,setName]=useState(proposal.name);
  const [category,setCategory]=useState(matchingTypes(types,proposal.name)[0]?.id??'');
  const [reason,setReason]=useState('');
  const action=useAction();
  const matches=matchingTypes(types,name);
  const exact=matches.find(type=>typeNameKey(type.name)===typeNameKey(name));
  function submit(event:FormEvent) {
    event.preventDefault();
    void action.run(()=>save(decision==='create'?{action:'create',name}:decision==='match'?{action:'match',category}:{action:'reject',reason}));
  }
  return <Modal title="Review type proposal" onClose={()=>{if(!action.busy)close();}}>
    <form className="space-y-3" onSubmit={submit}>
      <p className="break-words">Submitted as <strong>{proposal.name}</strong></p>
      {proposal.description && <p className="break-words">{proposal.description}</p>}
      <Field label="Decision"><select value={decision} onChange={event=>setDecision(event.target.value as Decision)}>
        <option value="create">Approve as a new type</option><option value="match">Use an existing type</option><option value="reject">Reject</option>
      </select></Field>
      {decision==='create' && <>
        <Field label="Approved type name"><input value={name} required minLength={catalogLimits.nameMin}
          maxLength={catalogLimits.nameMax} onChange={event=>setName(event.target.value)}/></Field>
        {!!matches.length && <div className="space-y-2">
          <p className="text-sm font-semibold">{exact?'This type already exists. Use the matching record.':'Possible catalog matches'}</p>
          <div className="flex flex-wrap gap-2">{matches.map(type=><button type="button" className="button" key={type.id}
            onClick={()=>{setDecision('match');setCategory(type.id);}}>Use {type.name}</button>)}</div>
        </div>}
      </>}
      {decision==='match' && <Field label="Existing equipment type"><Categories types={types} value={category} onChange={setCategory}/></Field>}
      {decision==='reject' && <Field label="Reason shown to the resident"><textarea required maxLength={catalogLimits.reason}
        value={reason} onChange={event=>setReason(event.target.value)}/></Field>}
      <p className="text-sm muted">{decision==='reject'?'The resident will see your reason. No request or type will be created.'
        :decision==='create'?'This creates a public type and records the resident’s request.'
          :'This records the resident’s request under the selected type. An existing active request stays as it is.'}</p>
      <button className="button primary" disabled={action.busy||(decision==='create'&&!!exact)}>{decision==='reject'?'Confirm rejection':'Confirm approval'}</button>
      <Feedback error={action.error}/>
    </form>
  </Modal>;
}
