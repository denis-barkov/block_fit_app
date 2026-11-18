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
  const [locating,setLocating]=useState(false);
  const action=useAction();
  async function load() {setData(await api<Data>('/resident'));setLoadError('');}
  useEffect(()=>{void load().catch(error=>setLoadError(message(error)));},[]);
  const openedHandoff=useRef(false);
  useEffect(()=>{
    if (!data || openedHandoff.current || !new URLSearchParams(location.search).has('category')) return;
    openedHandoff.current=true;
    history.replaceState(null,'','/requests');
    if (data.location) setDraft(true);
    else setLocating(true);
  },[data]);
  function update(id:string,command:string) {
    void action.run(async()=>{await api(`/resident/requests/${id}/${command}`,'POST',{});await load();},
      command==='withdraw'?'Request withdrawn.':command==='restore'?'Request restored.':'Request reconfirmed.');
  }
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">Resident account</p><h1>My requests</h1>
      <p className="mt-2 muted">Request equipment near one private location in {pilot.name}.</p></header>
    <Feedback error={loadError}/>
    {!data && (loadError ? <button className="button" onClick={()=>void load().catch(error=>setLoadError(message(error)))}>Retry</button> : <p role="status">Loading your requests…</p>)}
    {data && <div className="split">
      <section className="panel space-y-3"><h2>Saved location</h2>
        {data.location ? <p>{data.location.label||'Private pilot location'}</p> : <p>No location saved yet.</p>}
        <p className="text-sm muted">Use a demonstration location. You do not need to enter a home address.</p>
        <button className="button" onClick={()=>setLocating(true)}>{data.location?'Change saved location':'Set private location'}</button>
      </section>
      <section className="panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2>Request history</h2>
          <button className="button primary" onClick={()=>data.location?setDraft(true):setLocating(true)}>New request</button>
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
          </>:<button className="button" disabled={action.busy} onClick={()=>update(item.id,'restore')}>Restore request</button>}</div>
        </article>)}
      </section>
    </div>}
    {locating && data && <LocationDialog saved={data.location} close={()=>setLocating(false)} save={async value=>{
      await api('/resident/location','PUT',value);
      await load();setLocating(false);
      if(!data.location)setDraft(true);
    }}/>}
    {draft && data?.location && <RequestDialog initial={draft===true?undefined:draft} initialCategory={requestCategory}
      saved={data.location} close={()=>setDraft(null)} save={async value=>{
        const id=draft===true?'':`/${draft.id}`;
        await api(`/resident/requests${id}`,id?'PUT':'POST',value);await load();setDraft(null);
        await action.run(async()=>{},id?'Request updated.':'Request recorded.');
      }}/>}
  </main>;
}

function LocationDialog({saved,close,save}: {saved:SavedLocation|null;close:()=>void;save:(value:SavedLocation&{confirmed:true})=>Promise<void>}) {
  const [point,setPoint]=useState<Coordinate>(saved||pilot.center);
  const [label,setLabel]=useState(saved?.label||'');
  const action=useAction();
  return <Modal title="Confirm private request origin" onClose={()=>{if(!action.busy)close();}}>
    <form className="space-y-3" onSubmit={event=>{event.preventDefault();void action.run(()=>save({lat:point.lat,lng:point.lng,label,confirmed:true}));}}>
      <p className="text-sm muted">Select a map pin, drag it, or enter coordinates in the pilot area.</p>
      <Suspense fallback={<p>Loading map…</p>}><MapView label="Private location selection" onPick={setPoint} pins={[{
        ...point,id:'private-origin',label:'Private location pin',kind:'reference',short:'•',onMove:setPoint,
      }]}/></Suspense>
      <Coordinates value={point} onChange={setPoint}/>
      <Field label="Location label (optional)"><input maxLength={limits.shortText} value={label} onChange={e=>setLabel(e.target.value)}/></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" required/>
        {saved?'Move all my active requests to this location.':'Use this private origin to measure equipment coverage.'}</label>
      <button className="button primary" disabled={action.busy}>Save location</button>
      <Feedback error={action.error}/>
    </form>
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
        <p><strong>{categories[category]}</strong> near {saved.label||'your private pilot location'}.</p>
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
          onChange={event=>setPoint(event.target.checked?pilot.center:null)}/> Add a suggested point</label>
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
