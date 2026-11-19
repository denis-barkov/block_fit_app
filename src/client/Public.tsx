import { Compass, MapPin } from 'lucide-react';
import { publicLinks } from '../../config/app';
import { isInServiceArea, mapArea } from '../../config/map-area';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { defaultCategory, limits, pilot } from '../../config/settings';
import type { Category, Coordinate, EquipmentType, PublicEquipment } from '../contracts';
import { travel } from '../../config/travel';
import { approxDistance, byDistance, distanceBand, distanceNotice, eligible, reasonText, type Observations, type TravelSuggestion } from '../travel';
import type { CollectEvidence } from './map-evidence';
import { loginLink } from '../routes';
import { rememberTravel, takeTravel } from './travel-return';
import DestinationActions,{mapsHandoff} from './DestinationActions';
import type { SavedLocation } from '../contracts';
import { api, Categories, Feedback, Field, InfoHint, message, preferredType, useAction } from './common';

const MapView=lazy(()=>import('./Map'));
const TravelPanel=lazy(()=>import('./TravelPanel'));
export default function Public({request,role,types}: {request?: (category:Category)=>void;role:'resident'|'staff'|null;types:EquipmentType[]}) {
  const [returning]=useState(()=>role==='resident'?takeTravel():undefined);
  const [category,setCategory]=useState<Category|''>(returning?.category??'');
  const [search,setSearch]=useState(returning?.query??'');
  const [query,setQuery]=useState(returning?.query??'');
  const [results,setResults]=useState<PublicEquipment[]>([]);
  const [selected,setSelected]=useState(returning?.target??'');
  const [reference,setReference]=useState<Coordinate|null>(returning?.origin??null);
  const [pick,setPick]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const [visible,setVisible]=useState(travel.visiblePageSize);
  const [helper,setHelper]=useState<{target:string|null}|null>(returning?{target:returning.target}:null);
  const [suggestion,setSuggestion]=useState<TravelSuggestion&{context:string}>();
  const [focusPoint,setFocusPoint]=useState<Coordinate>();
  const [inventoryVersion,setInventoryVersion]=useState(0);
  const evidence=useRef<CollectEvidence|null>(null);
  const opener=useRef<HTMLElement|null>(null);
  const pinControl=useRef<HTMLButtonElement|null>(null);
  const mapHeading=useRef<HTMLHeadingElement|null>(null);
  const context=JSON.stringify([category,query,reference,inventoryVersion]);
  const observations=useRef<{context:string;entries:Map<string,Observations>}|null>(null);
  const savedPin=useAction();
  const unavailable=!!category && !types.some(type=>type.id===category);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');setVisible(travel.visiblePageSize);
    async function load() {
      const equipment:PublicEquipment[]=[];
      let after='';
      for(;;) {
        const params=new URLSearchParams({category:unavailable?'':category,q:query,after});
        const response=await fetch(`/api/inventory?${params}`,{signal:controller.signal});
        if(response.status===409) throw new Error('This equipment type is currently unavailable. Choose another type.');
        if(!response.ok) throw new Error('Equipment could not be loaded. Try again.');
        const page:PublicEquipment[]=await response.json();
        equipment.push(...page);
        if(page.length<travel.pageSize) break;
        after=page[page.length-1].id;
      }
      if(controller.signal.aborted) return;
      equipment.sort((left,right)=>left.name.localeCompare(right.name)||left.id.localeCompare(right.id));
      setResults(equipment);setInventoryVersion(value=>value+1);
      setSelected(id=>equipment.some(item=>item.id===id)?id:equipment[0]?.id??'');
    }
    void load().catch(err=>{if(!controller.signal.aborted)setError(message(err));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[category,query,retry,types,unavailable]);
  const sorted=useMemo(()=>reference?byDistance(results,reference).map(({site,distance})=>({item:site,distance}))
    :results.map(item=>({item,distance:null})),[results,reference]);
  const sites=useMemo(()=>results.filter(eligible),[results]);
  const item=results.find(row=>row.id===selected);
  const target=sites.find(site=>site.id===helper?.target)??null;
  const matches=sites.filter(site=>!category||unavailable||site.category===category);
  const matchIds=new Set(matches.map(site=>site.id));
  const noClose=reference && matches.length && !sorted.some(entry=>entry.distance!==null &&
    entry.distance<=travel.bands[1].limit && matchIds.has(entry.item.id));
  const shown=sorted.slice(0,visible);
  const markers=sorted.slice(0,Math.max(visible,travel.pageSize)).map(entry=>entry.item);
  if(item&&!markers.includes(item)) markers.push(item);
  function closeHelper() {
    setHelper(null);
    requestAnimationFrame(()=>opener.current?.focus());
  }
  function openHelper(event:MouseEvent<HTMLButtonElement>,id:string|null) {
    opener.current=event.currentTarget;
    setHelper({target:id});
  }
  function showSuggestion(option:TravelSuggestion) {
    const index=sorted.findIndex(({item})=>item.id===option.id);
    if(index<0)return;
    const {lat,lng}=sorted[index].item;
    setSelected(option.id);setSuggestion({...option,context});
    setVisible(count=>Math.max(count,index+1));
    setFocusPoint({lat,lng});setPick(false);setHelper(null);
    requestAnimationFrame(()=>{
      mapHeading.current?.focus({preventScroll:true});
      mapHeading.current?.scrollIntoView({block:'start'});
    });
  }
  async function collect(points:Parameters<CollectEvidence>[0],signal:AbortSignal) {
    if(observations.current?.context!==context) observations.current={context,entries:new Map()};
    const cache=observations.current.entries;
    const key=JSON.stringify(Object.keys(points));
    const prior=cache.get(key);
    if(prior) return prior;
    const snapshot=await evidence.current?.(points,signal)??{};
    if(!signal.aborted) cache.set(key,snapshot);
    return snapshot;
  }
  function submit(event:FormEvent) {event.preventDefault();setQuery(search.trim());}
  return <main>
    <section className="border-b border-line bg-white">
      <div className="shell grid gap-4 py-6 md:grid-cols-[2fr_1fr] md:items-end md:gap-6 md:py-10 xl:py-14">
        <div><p className="eyebrow mb-3">Explore {mapArea.name}</p>
          <h1>Find outdoor fitness equipment.</h1>
          <p className="mt-3 max-w-2xl muted md:text-lg">See what’s nearby, check what’s been verified, and tell us what’s missing.</p></div>
        <p className="border-l-2 border-brand pl-4 text-sm muted">Demo equipment is placed in and around {pilot.name}. Check site details before visiting.</p>
      </div>
    </section>
    <div className="shell space-y-5 py-6">
      <form className="panel grid grid-cols-2 items-end gap-3 md:grid-cols-[1fr_1.5fr_auto]" onSubmit={submit}>
        <Field label="Equipment type"><Categories types={types} all value={category} onChange={setCategory}/></Field>
        <Field label="Site or park name"><input maxLength={limits.shortText} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name"/></Field>
        <button className="button primary col-span-2 md:col-span-1">Find equipment</button>
      </form>
      {unavailable && <p role="status">This type is currently unavailable for filtering. Showing all equipment.</p>}
      <div className="split">
        <section className="panel space-y-4 xl:col-start-2 xl:row-start-1" aria-labelledby="neighborhood-map">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="neighborhood-map" ref={mapHeading} tabIndex={-1} className="text-lg md:text-xl">Neighborhood map</h2>
            <div className="flex flex-wrap gap-2">
              <button ref={pinControl} className="button gap-2 max-md:px-2.5" aria-pressed={pick} onClick={()=>setPick(!pick)}>
                <MapPin className="action-icon hidden md:block" aria-hidden="true"/> {pick?'Cancel pin selection':'Set reference pin'}
              </button>
              {reference && <button className="button" onClick={()=>{setReference(null);setHelper(null);}}>Clear reference</button>}
              {role==='resident' && <button className="button" disabled={savedPin.busy} onClick={()=>void savedPin.run(async()=>{
                const {location}=await api<{location:SavedLocation|null}>('/resident');
                if(!location||!isInServiceArea(location)) throw new Error(`Save a request location in ${mapArea.pinBoroughs}, or set a reference pin.`);
                setReference({lat:location.lat,lng:location.lng});setPick(false);
              })}>Use saved request pin</button>}
            </div>
          </div>
          <Feedback error={savedPin.error}/>
          {pick && <p role="status" className="text-sm muted">Click the map to sort listings by approximate straight-line distance.</p>}
          <Suspense fallback={<p>Loading map…</p>}><MapView label="Public equipment map" evidence={evidence} initialCenter={returning?.origin??undefined} focusPoint={focusPoint}
            onPick={pick?point=>{setReference(point);setPick(false);}:undefined}
            pins={[...markers.map((row,index)=>({...row,label:row.name,kind:'equipment' as const,short:String(index+1),
              selected:row.id===selected,onSelect:()=>{if(!pick)setSelected(row.id);}})),
              ...(reference?[{...reference,kind:'reference' as const,id:'reference',label:'Reference point',short:'•'}]:[])]}/>
          </Suspense>
          {item && <article className="rounded-control border border-line p-4" aria-label="Selected equipment">
            <InfoHint label="About Maps links" content={<p>{mapsHandoff}</p>}><h3>{item.name}</h3></InfoHint>
            <p className="text-sm muted">{item.categoryName} · {item.park?.name||'Standalone equipment'}</p>
            {!item.categoryActive && <p className="text-sm muted">This type is unavailable for new requests and travel suggestions.</p>}
            {suggestion?.id===item.id&&suggestion.context===context&&<p className="text-sm muted">{reasonText[suggestion.reason]}</p>}
            <dl className="my-4 grid gap-3 text-sm sm:grid-cols-2">
              {Object.entries({Verification:item.fixture&&item.verifiedOn?`Simulated · ${item.verifiedOn}`:item.verifiedOn||'Unverified',Condition:item.condition,
                'Public access':item.access,Hours:item.park?.hours||'Unknown',Source:item.source||'Unknown'})
                .map(([key,value])=><div key={key}><dt className="font-bold">{key}</dt><dd>{value}</dd></div>)}
            </dl>
            {eligible(item)&&<button className="button mb-2" onClick={event=>openHelper(event,item.id)}>Explore this location</button>}
            <DestinationActions key={item.id} site={item}/>
            <div className="mt-2 flex flex-wrap gap-2">
              {request && item.categoryActive && <button className="button" onClick={()=>request(item.category)}>Request this equipment nearby</button>}
              {item.park?.cityMaintained && <a className="button" target="_blank" rel="noreferrer" href={publicLinks.parkMaintenance}>Report a City park problem ↗</a>}
            </div>
          </article>}
        </section>
        <section className="panel xl:col-start-1 xl:row-start-1" aria-labelledby="equipment-listings" aria-busy={loading}>
          {reference ? <InfoHint label="How distances are measured" content={<p>{distanceNotice}</p>}>
            <h2 id="equipment-listings">Equipment listings</h2>
          </InfoHint> : <h2 id="equipment-listings">Equipment listings</h2>}
          <p className="mb-3 text-sm muted" role="status">{loading?'Loading equipment…':`${results.length} listed locations`}</p>
          <Feedback error={error}/>{error && <button className="button" onClick={()=>setRetry(retry+1)}>Retry search</button>}
          {!error && !loading && !results.length && <p>No matching equipment is listed. Try a different site name or equipment type.</p>}
          {!error && !loading && !!results.length && !matches.length &&
            <p className="mb-3 text-sm muted">{results.some(item=>item.categoryActive)
              ? 'No matching locations of active types have confirmed public access, usable equipment, and a verification record.'
              : 'Travel suggestions are unavailable for the listed equipment types.'}</p>}
          {!loading && !error && !!matches.length && <button className="button mb-3 gap-2" onClick={event=>openHelper(event,null)}>
            <Compass className="action-icon" aria-hidden="true"/>
            {noClose?'Nothing close by? Explore travel options.':'Explore travel options'}
          </button>}
          <ul className="space-y-2">
            {shown.map(({item,distance})=><li key={item.id}>
              <button className={`w-full rounded-control border p-3 text-left ${selected===item.id?'border-brand bg-mint':'border-line bg-white hover:bg-canvas'}`}
                onClick={()=>setSelected(item.id)} aria-pressed={selected===item.id}>
                <span className="block font-bold">{item.name}</span>
                <span className="block text-sm muted">{item.categoryName} · {item.park?.name||'Standalone equipment'}</span>
                <span className={`tag mt-2 ${item.verifiedOn?'':'unverified'}`}>{item.fixture && item.verifiedOn?'Simulated verification':item.verifiedOn?'Verification recorded':'Unverified'}</span>
                {item.access!=='public' && <span className="tag unverified ml-2">{item.access==='restricted'?'Restricted access':'Public access unknown'}</span>}
                {item.fixture && <span className="ml-2 text-xs muted">Illustrative demo equipment</span>}
                {distance!==null && <span className="ml-2 text-xs muted">Approx. distance {approxDistance(distance)} · {distanceBand(distance)}</span>}
              </button>
            </li>)}
          </ul>
          {visible<sorted.length && <button className="button mt-3" onClick={()=>setVisible(value=>value+travel.visiblePageSize)}>Show more locations</button>}
        </section>
      </div>
      {helper && !loading && !error && <Suspense fallback={<p role="status">Opening travel options…</p>}>
        <TravelPanel key={JSON.stringify([context,helper.target,role])} category={unavailable?'':category} query={query}
          origin={reference} sites={sites} target={target} role={role} collect={collect} close={closeHelper} onChoose={showSuggestion}
          chooseOrigin={()=>{setHelper(null);setPick(true);requestAnimationFrame(()=>pinControl.current?.focus());}}
          signIn={()=>{
            rememberTravel({category,query,origin:reference,target:helper.target});
            location.assign(loginLink('resident','/'));
          }}/>
      </Suspense>}
      {request && <section className="panel flex flex-wrap items-center justify-between gap-4">
        <div><h2>Missing something nearby?</h2><p className="muted">Your request can inform future investment comparisons.</p></div>
        <button className="button primary" onClick={()=>request((!unavailable&&category)||(item?.categoryActive&&item.category)||preferredType(types)||defaultCategory)}>Request equipment nearby</button>
      </section>}
    </div>
  </main>;
}
