import { mapArea, isInServiceArea, pinOutsideServiceArea } from '../../config/map-area';
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { categories,limits,pilot,planning } from '../../config/settings';
import type { Category, Coordinate, Demand, SavedLocation } from '../contracts';
import { api,Categories,Coordinates,Feedback,Field,message,Modal,useAction } from './common';

const MapView=lazy(()=>import('./Map'));
type Data={location:SavedLocation|null; requests:Demand[]};
export default function Resident({initialCategory}: {initialCategory:Category}) {
  const [requestCategory]=useState(initialCategory);
  const [data,setData]=useState<Data|null>(null);
  const [loadError,setLoadError]=useState('');
  const [draft,setDraft]=useState<Demand|true|null>(null);
  const [locating,setLocating]=useState<'location'|'request'|null>(null);
  const [removing,setRemoving]=useState(false);
  const activeRequests=data?.requests.filter(request=>request.status==='recorded').length ?? 0;
  const outside=!!data?.location && !isInServiceArea(data.location);
  const canUseLocation=!!data?.location?.useForRequests && !outside;
  const action=useAction();
  async function load() {setData(await api<Data>('/resident'));setLoadError('');}
  useEffect(()=>{void load().catch(error=>setLoadError(message(error)));},[]);
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
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">Resident account</p><h1>My requests</h1>
      <p className="mt-2 muted">Request equipment near one private location in {mapArea.name}.</p></header>
    <Feedback error={loadError}/>
    {!data && (loadError ? <button className="button" onClick={()=>void load().catch(error=>setLoadError(message(error)))}>Retry</button> : <p role="status">Loading your requests…</p>)}
    {data && <div className="split">
      <section className="panel space-y-3"><h2>Saved location</h2>
        {data.location ? <>
          <p>{data.location.label||'Private saved location'}</p>
          <p className="text-sm muted">{outside?`Your saved pin is outside ${mapArea.name}. Move it before starting a new request.`
            : canUseLocation?'Used for new requests.':'New requests require you to choose a location.'}</p>
        </> : <p>No location saved yet.</p>}
        <p className="text-sm muted">You can use a nearby landmark or intersection.</p>
        <div className="flex flex-wrap gap-2">
          <button className="button" disabled={action.busy} onClick={()=>setLocating('location')}>
            {data.location?'Change saved location':'Set private location'}
          </button>
          {data.location && <button className="button" disabled={action.busy} onClick={()=>setRemoving(true)}>Remove saved location</button>}
        </div>
      </section>
      <section className="panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>Request history</h2>
          <button className="button primary" disabled={action.busy} onClick={()=>canUseLocation?setDraft(true):setLocating('request')}>New request</button>
        </div>
        <p className="text-sm muted">“Recorded” means your request is saved. Funding and installation require separate City review.</p>
        <Feedback {...action}/>
        {!data.requests.length && <p>No requests yet.</p>}
        {data.requests.map(item=><article className="space-y-2 rounded-control border border-line p-3" key={item.id}>
          <div className="flex flex-wrap items-center gap-2"><h3>{categories[item.category]}</h3>
            <span className={`tag ${item.status==='withdrawn'?'unverified':''}`}>{item.status==='recorded'?'Recorded':'Withdrawn'}</span></div>
          <p className="text-sm muted">Last confirmed {new Date(item.confirmedAt).toLocaleDateString()}</p>
          {item.note && <p className="break-words">{item.note}</p>}
          <div className="flex flex-wrap gap-2">{item.status==='recorded'?<>
            <button className="button" onClick={()=>setDraft(item)}>Edit request</button>
            <button className="button" disabled={action.busy} onClick={()=>update(item.id,'reconfirm')}>Still needed</button>
            <button className="button" disabled={action.busy} onClick={()=>update(item.id,'withdraw')}>Withdraw</button>
          </>:canUseLocation
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
    {draft && data?.location && <RequestDialog initial={draft===true?undefined:draft} initialCategory={requestCategory}
      saved={data.location} close={()=>setDraft(null)} save={async value=>{
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

function RequestDialog({initial,initialCategory,saved,close,save}: {
  initial?:Demand; initialCategory:Category; saved:SavedLocation; close:()=>void;
  save:(value:{category:Category;note:string;suggestion:string;point:Coordinate|null})=>Promise<void>;
}) {
  const [category,setCategory]=useState(initial?.category||initialCategory);
  const [note,setNote]=useState(initial?.note||'');
  const [suggestion,setSuggestion]=useState(initial?.suggestion||'');
  const [point,setPoint]=useState<Coordinate|null>(initial?.point||null);
  const [review,setReview]=useState(false);
  const reviewTitle=useRef<HTMLHeadingElement>(null);
  const action=useAction();
  useEffect(()=>{if(review)reviewTitle.current?.focus();},[review]);
  function submit(event:FormEvent) {
    event.preventDefault();
    if(!review){setReview(true);return;}
    void action.run(()=>save({category,note,suggestion,point}));
  }
  return <Modal title={initial?'Edit equipment request':'Request equipment nearby'} onClose={()=>{if(!action.busy)close();}}>
    <form className="space-y-3" onSubmit={submit}>
      {review ? <>
        <h3 ref={reviewTitle} tabIndex={-1}>Review your request</h3>
        <p><strong>{categories[category]}</strong> near {saved.label||'your private location'}.</p>
        {note && <p className="break-words">Note: {note}</p>}
        {suggestion && <p className="break-words">Suggested site: {suggestion}</p>}
        {point && <p>Suggested pin: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}</p>}
        <p className="text-sm muted">One active request per equipment type. This records demand for planning discussion.</p>
      </>:<>
        <Field label="Equipment type"><Categories value={category} onChange={value=>value&&setCategory(value)}/></Field>
        <p className="text-sm muted">Planning uses a {planning.radius} m straight-line radius around {saved.label||'your saved location'}.</p>
        <Field label="Note (optional)"><textarea value={note} maxLength={limits.text} onChange={e=>setNote(e.target.value)}/></Field>
        <Field label="Suggested installation site (optional)"><textarea value={suggestion} maxLength={limits.text}
          onChange={e=>setSuggestion(e.target.value)}/></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={point!==null}
          onChange={event=>setPoint(event.target.checked?{lat:saved.lat,lng:saved.lng}:null)}/> Add a suggested point</label>
        {point && <Coordinates value={point} onChange={setPoint}/>}
      </>}
      <div className="flex flex-wrap gap-2">
        {review && <button type="button" className="button" disabled={action.busy} onClick={()=>setReview(false)}>Back to edit</button>}
        <button className="button primary" disabled={action.busy}>{review?(initial?'Save changes':'Record request'):'Review request'}</button>
      </div>
      <Feedback error={action.error}/>
    </form>
  </Modal>;
}
