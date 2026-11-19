import { Plus } from 'lucide-react';
import { mapArea, isInServiceArea, pinOutsideServiceArea } from '../../config/map-area';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { catalogLimits,limits,pilot,planning } from '../../config/settings';
import { matchingTypes,typeName,typeNameKey,type Category,type Coordinate,type Demand,type EquipmentType,type ResidentProposal,type SavedLocation } from '../contracts';
import { api,Categories,Coordinates,Feedback,Field,InfoHint,message,Modal,preferredType,useAction } from './common';
import { localDate } from '../format';

const MapView=lazy(()=>import('./Map'));
type Data={location:SavedLocation|null;requests:Demand[];proposals:ResidentProposal[];proposalsNext:number|null;activeRequests:number};
type RequestDetails={note:string;suggestion:string;point:Coordinate|null};
type Submission=RequestDetails&({category:Category}|{name:string;description:string;submissionKey:string});
const proposalStatus={pending:'Awaiting type review',approved:'Approved',rejected:'Rejected',withdrawn:'Withdrawn'};
export default function Resident({initialCategory,types}: {initialCategory:Category|null;types:EquipmentType[]}) {
  const [requestCategory]=useState(initialCategory);
  const [data,setData]=useState<Data|null>(null);
  const [loadError,setLoadError]=useState('');
  const [draft,setDraft]=useState<Demand|true|null>(null);
  const [locating,setLocating]=useState<'location'|'request'|null>(null);
  const [removing,setRemoving]=useState(false);
  const activeRequests=data?.activeRequests??0;
  const outside=!!data?.location && !isInServiceArea(data.location);
  const canUseLocation=!!data?.location?.useForRequests && !outside;
  const action=useAction();
  async function load() {setData(await api<Data>('/resident'));setLoadError('');}
  useEffect(()=>{
    const refresh=()=>void load().catch(error=>setLoadError(message(error)));
    refresh();
    window.addEventListener('focus',refresh);
    return ()=>window.removeEventListener('focus',refresh);
  },[types]);
  const openedHandoff=useRef(false);
  useEffect(()=>{
    if (!data || openedHandoff.current || !new URLSearchParams(location.search).has('category')) return;
    openedHandoff.current=true;
    history.replaceState(null,'','/requests');
    if (canUseLocation) setDraft(true);
    else setLocating('request');
  },[data,canUseLocation]);
  function update(id:string,command:string) {
    void action.run(async()=>{await api(`/resident/requests/${id}/${command}`,'POST',{});await load();},
      command==='withdraw'?'Request withdrawn.':command==='restore'?'Request restored.':'Request reconfirmed.');
  }
  function openLinkedRequest(id:string) {
    void action.run(async()=>{
      const item=await api<Demand>(`/resident/requests/${id}`);
      setData(value=>value&&!value.requests.some(request=>request.id===id)?{...value,requests:[...value.requests,item]}:value);
      requestAnimationFrame(()=>{window.location.hash=`request-${id}`;document.getElementById(`request-${id}`)?.focus();});
    });
  }
  function moreProposals(offset:number) {
    void action.run(async()=>{
      const next=await api<{items:ResidentProposal[];next:number|null}>(`/resident/proposals?offset=${offset}`);
      setData(value=>value?.proposalsNext===offset?
        {...value,proposals:[...value.proposals,...next.items.filter(item=>!value.proposals.some(prior=>prior.id===item.id))],proposalsNext:next.next}
        :value);
    });
  }
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">Resident account</p><h1>My requests</h1>
      <p className="mt-2 muted">Request equipment near one private location in {mapArea.name}.</p></header>
    <Feedback error={loadError}/>
    {!data && (loadError ? <button className="button" onClick={()=>void load().catch(error=>setLoadError(message(error)))}>Retry</button> : <p role="status">Loading your requests…</p>)}
    {data && <div className="split">
      <section className="panel space-y-3">
        <InfoHint label="About your saved location" content={<p>You can use a nearby landmark or intersection.</p>}>
          <h2>Saved location</h2>
        </InfoHint>
        {data.location ? <>
          <p>{data.location.label||'Private saved location'}</p>
          <p className="text-sm muted">{outside?`Your saved pin is outside ${mapArea.name}. Move it before starting a new request.`
            : canUseLocation?'Used for new requests.':'New requests require you to choose a location.'}</p>
        </> : <p>No location saved yet.</p>}
        <div className="flex flex-wrap gap-2">
          <button className="button" disabled={action.busy} onClick={()=>setLocating('location')}>
            {data.location?'Change saved location':'Set private location'}
          </button>
          {data.location && <button className="button" disabled={action.busy} onClick={()=>setRemoving(true)}>Remove saved location</button>}
        </div>
      </section>
      <section className="panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <InfoHint label="What recorded means" content={<p>“Recorded” means your request is saved. Funding and installation require separate City review.</p>}>
            <h2>Request history</h2>
          </InfoHint>
          <button className="button primary gap-2" disabled={action.busy} onClick={()=>canUseLocation?setDraft(true):setLocating('request')}>
            <Plus className="action-icon" aria-hidden="true"/> New request
          </button>
        </div>
        <Feedback {...action}/>
        {!data.requests.length && !data.proposals.length && <p>No requests yet.</p>}
        {data.proposals.map(proposal=><article className="space-y-2 rounded-control border border-line p-3" key={proposal.id}>
          <div className="flex flex-wrap items-center gap-2"><h3 className="break-words">{proposal.name}</h3>
            <span className="tag">{proposalStatus[proposal.status]}</span></div>
          {proposal.status==='pending' && <>
            <p className="text-sm muted">This suggestion will count toward planning only if staff approves it.</p>
            <button className="button" disabled={action.busy} onClick={()=>void action.run(async()=>{
              await api(`/resident/proposals/${proposal.id}/withdraw`,'POST',{});await load();
            },'Suggestion withdrawn.')}>Withdraw suggestion</button>
          </>}
          {proposal.status==='approved' && <>
            <p className="break-words">Approved as {proposal.categoryName}.</p>
            {proposal.reusedRequest && <p>You already have an active request for this type.</p>}
            {proposal.requestId && <a className="font-bold underline" href={`#request-${proposal.requestId}`} onClick={event=>{
              if(proposal.requestId&&!data.requests.some(item=>item.id===proposal.requestId)) {
                event.preventDefault();openLinkedRequest(proposal.requestId);
              }
            }}>View equipment request</a>}
          </>}
          {proposal.status==='rejected' && <p className="break-words">{proposal.reason} You can submit a corrected suggestion.</p>}
        </article>)}
        {data.proposalsNext!==null && <button className="button" disabled={action.busy}
          onClick={()=>{if(data.proposalsNext!==null)moreProposals(data.proposalsNext);}}>
          Show earlier type suggestions
        </button>}
        {data.requests.map(item=><article id={`request-${item.id}`} tabIndex={-1}
          className="space-y-2 rounded-control border border-line p-3 target:border-brand" key={item.id}>
          <div className="flex flex-wrap items-center gap-2"><h3>{item.categoryName}</h3>
            <span className={`tag ${item.status==='withdrawn'?'unverified':''}`}>{item.status==='recorded'?'Recorded':'Withdrawn'}</span></div>
          {!item.categoryActive && <p className="text-sm muted">Type currently unavailable</p>}
          <p className="text-sm muted">Last confirmed <time dateTime={item.confirmedAt}>{localDate(item.confirmedAt)}</time></p>
          {item.note && <p className="break-words">{item.note}</p>}
          <div className="flex flex-wrap gap-2">{item.status==='recorded'?<>
            {item.categoryActive && <><button className="button" onClick={()=>setDraft(item)}>Edit request</button>
              <button className="button" disabled={action.busy} onClick={()=>update(item.id,'reconfirm')}>Still needed</button></>}
            <button className="button" disabled={action.busy} onClick={()=>update(item.id,'withdraw')}>Withdraw</button>
          </>:!item.categoryActive ? null : canUseLocation
            ? <button className="button" disabled={action.busy} onClick={()=>update(item.id,'restore')}>Restore request</button>
            : <p className="text-sm muted">Choose a saved location in {mapArea.name} to restore this request.</p>}</div>
        </article>)}
      </section>
    </div>}
    {locating && data && <LocationDialog saved={data.location} activeRequests={activeRequests}
      forRequest={locating==='request'} close={()=>setLocating(null)} save={async (value,move)=>{
        await api(move?'/resident/location/move':'/resident/location',move?'POST':'PUT',move?{...value,activeRequests}:value);
        await load();
        if(locating==='request' && value.useForRequests) setDraft(true);
        setLocating(null);
      }}/>}
    {removing && data?.location && <RemoveLocationDialog activeRequests={activeRequests} close={()=>setRemoving(false)}
      remove={async()=>{
        await api('/resident/location','DELETE');
        await load();
        setRemoving(false);
        await action.run(async()=>{},'Saved location removed.');
      }}/>}
    {draft && data?.location && <RequestDialog initial={draft===true?undefined:draft} initialCategory={requestCategory} types={types}
      saved={data.location} close={()=>setDraft(null)} save={async value=>{
        if('submissionKey'in value) {
          await api('/resident/proposals','POST',value);await load();setDraft(null);
          await action.run(async()=>{},'Suggestion submitted for type review.');
          return;
        }
        const id=draft===true?'':`/${draft.id}`;
        await api(`/resident/requests${id}`,id?'PUT':'POST',value);await load();setDraft(null);
        await action.run(async()=>{},id?'Request updated.':'Request recorded.');
      }}/>}
  </main>;
}

const requestCount = (count: number) => `${count} active request${count===1?'':'s'}`;

function LocationDialog({saved,activeRequests,forRequest,close,save}: {
  saved:SavedLocation|null; activeRequests:number; forRequest:boolean; close:()=>void;
  save:(value:SavedLocation,move:boolean)=>Promise<void>;
}) {
  const [point,setPoint]=useState<Coordinate>(saved||pilot.center);
  const [label,setLabel]=useState(saved?.label||'');
  const [useForRequests,setUseForRequests]=useState(saved?.useForRequests ?? true);
  const [confirmMove,setConfirmMove]=useState(false);
  const moveHeading=useRef<HTMLHeadingElement>(null);
  const action=useAction();
  const moved=!!saved && (point.lat!==saved.lat || point.lng!==saved.lng);
  useEffect(()=>{if(confirmMove)moveHeading.current?.focus();},[confirmMove]);
  const submit=()=>void action.run(()=>save({lat:point.lat,lng:point.lng,label,useForRequests},moved));
  return <Modal title={saved?'Change saved location':'Save a private location'} onClose={()=>{if(!action.busy)close();}}>
    {confirmMove ? <div className="space-y-3">
      <h3 ref={moveHeading} tabIndex={-1}>Move to this location?</h3>
      <p>{activeRequests ? `You have ${requestCount(activeRequests)}. ${activeRequests===1?'It will move':'They will all move'} to this pin.`
        : 'You have no active requests. This will update your saved pin.'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button" disabled={action.busy} onClick={()=>setConfirmMove(false)}>Back</button>
        <button type="button" className="button primary" disabled={action.busy} onClick={submit}>Confirm move</button>
      </div>
      <Feedback error={action.error}/>
    </div> : <form className="space-y-3" onSubmit={event=>{
      event.preventDefault();
      if(!isInServiceArea(point)) return;
      if(moved) setConfirmMove(true);
      else submit();
    }}>
      <p className="text-sm muted">Select a pin, drag it, or enter coordinates in {mapArea.name}.</p>
      <Suspense fallback={<p>Loading map…</p>}><MapView label="Private location selection" initialCenter={point} onPick={setPoint} pins={[{
        ...point,id:'private-origin',label:'Private location pin',kind:'reference',short:'•',onMove:setPoint,
      }]}/></Suspense>
      <Coordinates value={point} onChange={setPoint}/>
      {!isInServiceArea(point) && <p className="text-sm muted">{pinOutsideServiceArea}</p>}
      <Field label="Location label (optional)"><input maxLength={limits.shortText} value={label} onChange={e=>setLabel(e.target.value)}/></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useForRequests}
        onChange={event=>setUseForRequests(event.target.checked)}/> Use this saved location for new requests</label>
      {forRequest && !useForRequests && <p className="text-sm muted">Enable this location to continue with your request.</p>}
      <button className="button primary" disabled={action.busy}>{moved?'Move location':'Save location'}</button>
      <Feedback error={action.error}/>
    </form>}
  </Modal>;
}

function RemoveLocationDialog({activeRequests,close,remove}: {activeRequests:number;close:()=>void;remove:()=>Promise<void>}) {
  const action=useAction();
  return <Modal title="Remove saved location" onClose={()=>{if(!action.busy)close();}}>
    <div className="space-y-3">
      {activeRequests>0 ? <p>You have {requestCount(activeRequests)}. Withdraw the active requests before removing this pin.
        To keep them active at another spot, use Move location instead.</p> : <>
        <p>You’ll need to save a location again before you can make a new request. Past requests keep their recorded locations.</p>
        <button type="button" className="button primary" disabled={action.busy} onClick={()=>void action.run(remove)}>
          Confirm removal
        </button>
      </>}
      <Feedback error={action.error}/>
    </div>
  </Modal>;
}

function RequestDialog({initial,initialCategory,types,saved,close,save}: {
  initial?:Demand;initialCategory:Category|null;types:EquipmentType[];saved:SavedLocation;close:()=>void;
  save:(value:Submission)=>Promise<void>;
}) {
  const [category,setCategory]=useState(initial?.category??initialCategory??preferredType(types));
  const [suggesting,setSuggesting]=useState(!initial&&!types.length);
  const [name,setName]=useState('');
  const [description,setDescription]=useState('');
  const [submissionKey]=useState(()=>crypto.randomUUID());
  const [note,setNote]=useState(initial?.note||'');
  const [suggestion,setSuggestion]=useState(initial?.suggestion||'');
  const [point,setPoint]=useState<Coordinate|null>(initial?.point||null);
  const [review,setReview]=useState(false);
  const reviewTitle=useRef<HTMLHeadingElement>(null);
  const action=useAction();
  const matches=matchingTypes(types,name);
  const selected=types.find(type=>type.id===category);
  useEffect(()=>{if(review)reviewTitle.current?.focus();},[review]);
  function submit(event:FormEvent) {
    event.preventDefault();
    void action.run(async()=>{
      if(suggesting) {
        const valid=typeName.safeParse(name);
        if(!valid.success) throw new Error(`Enter an equipment name with ${catalogLimits.nameMin}–${catalogLimits.nameMax} characters and no control characters.`);
        if(!review) {
          const {availability}=await api<{availability:string}>('/resident/proposal-name','POST',{name:valid.data});
          if(availability==='inactive') throw new Error('This equipment type is currently unavailable. Choose another type or suggest a different one.');
          if(availability==='active') {
            const match=types.find(type=>typeNameKey(type.name)===typeNameKey(valid.data));
            if(match) throw new Error('This type already exists. Select it under Matching equipment types.');
            throw new Error('This type is already in the catalog. Refresh your page to select it.');
          }
          setReview(true);
          return;
        }
        await save({name:valid.data,description,submissionKey,note,suggestion,point});
        return;
      }
      if(!selected) throw new Error('Choose an active equipment type.');
      if(!review){setReview(true);return;}
      await save({category,note,suggestion,point});
    });
  }
  return <Modal title={initial?'Edit equipment request':'Request equipment nearby'} onClose={()=>{if(!action.busy)close();}}
    help={{label:'How your location is used',content:<p>
      Planning uses a {planning.radius} m straight-line radius around {saved.label||'your saved location'}.
    </p>}}>
    <form className="space-y-3" onSubmit={submit}>
      {review ? <>
        <h3 ref={reviewTitle} tabIndex={-1}>{suggesting?'Review your type suggestion':'Review your request'}</h3>
        <p className="break-words"><strong>{suggesting?name:selected?.name}</strong> near {saved.label||'your private location'}.</p>
        {suggesting && description && <p className="break-words">{description}</p>}
        {note && <p className="break-words">Note: {note}</p>}
        {suggestion && <p className="break-words">Suggested site: {suggestion}</p>}
        {point && <p>Suggested pin: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}</p>}
        <p className="text-sm muted">{suggesting?'Staff will review this type before your request counts toward planning.'
          :'One active request per equipment type. This records demand for planning discussion.'}</p>
      </>:<>
        {suggesting ? <>
          <Field label="Proposed equipment type"><input value={name} required minLength={catalogLimits.nameMin}
            maxLength={catalogLimits.nameMax} onChange={event=>setName(event.target.value)}/></Field>
          <Field label="Type description (optional)"><textarea value={description} maxLength={catalogLimits.description}
            onChange={event=>setDescription(event.target.value)}/></Field>
          {!!matches.length && <div className="space-y-2">
            <p className="text-sm font-semibold">Matching equipment types</p>
            <div className="flex flex-wrap gap-2">{matches.map(type=><button type="button" className="button" key={type.id}
              onClick={()=>{setCategory(type.id);setSuggesting(false);}}>Use {type.name}</button>)}</div>
          </div>}
          {!!types.length && <button type="button" className="button" onClick={()=>setSuggesting(false)}>Choose a catalog type</button>}
        </>:<>
          <Field label="Equipment type"><Categories types={types} value={category} onChange={setCategory}/></Field>
          {category&&!selected && <p className="text-sm muted">Type currently unavailable. Choose an active type or suggest another.</p>}
          {!initial && <button type="button" className="button" onClick={()=>setSuggesting(true)}>Suggest another type</button>}
        </>}
        <Field label="Note (optional)"><textarea value={note} maxLength={limits.text} onChange={e=>setNote(e.target.value)}/></Field>
        <Field label="Suggested installation site (optional)"><textarea value={suggestion} maxLength={limits.text}
          onChange={e=>setSuggestion(e.target.value)}/></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={point!==null}
          onChange={event=>setPoint(event.target.checked?{lat:saved.lat,lng:saved.lng}:null)}/> Add a suggested point</label>
        {point && <Coordinates value={point} onChange={setPoint}/>}
      </>}
      <div className="flex flex-wrap gap-2">
        {review && <button type="button" className="button" disabled={action.busy} onClick={()=>setReview(false)}>Back to edit</button>}
        <button className="button primary" disabled={action.busy||(!suggesting&&!selected)}>{review?(suggesting?'Submit type suggestion':initial?'Save changes':'Record request')
          :suggesting?'Review suggestion':'Review request'}</button>
      </div>
      <Feedback error={action.error}/>
    </form>
  </Modal>;
}
