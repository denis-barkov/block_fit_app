import { mapArea } from '../../config/map-area';
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { categories, limits,  pilot } from '../../config/settings';
import type { Category, Coordinate, PublicEquipment } from '../contracts';
import { metres } from '../server/planning';
import { Categories, Feedback, Field, message } from './common';

const MapView=lazy(()=>import('./Map'));
const maintenance='https://portal.311.nyc.gov/article/?kanumber=KA-01060';
export default function Public({request}: {request?: (category:Category)=>void}) {
  const [category,setCategory]=useState<Category|''>('');
  const [search,setSearch]=useState('');
  const [query,setQuery]=useState('');
  const [results,setResults]=useState<PublicEquipment[]>([]);
  const [selected,setSelected]=useState('');
  const [reference,setReference]=useState<Coordinate|null>(null);
  const [pick,setPick]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');
    const queryString=new URLSearchParams({category,q:query});
    void fetch(`/api/inventory?${queryString}`,{signal:controller.signal}).then(async response=>{
      if (!response.ok) throw new Error('Equipment could not be loaded. Try again.');
      const data:PublicEquipment[]=await response.json();
      setResults(data);
      setSelected(id=>data.some(item=>item.id===id)?id:data[0]?.id??'');
    }).catch(err=>{if(!controller.signal.aborted)setError(message(err));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[category,query,retry]);
  const sorted=results.map(item=>({item,distance:reference?metres(reference,item):null}))
    .sort((a,b)=>(a.distance??0)-(b.distance??0));
  const item=results.find(row=>row.id===selected);
  function submit(event:FormEvent) {event.preventDefault();setQuery(search.trim());}
  return <main>
    <section className="border-b border-line bg-white">
      <div className="shell grid gap-4 py-6 md:grid-cols-[2fr_1fr] md:items-end md:gap-6 md:py-10 xl:py-14">
        <div><p className="eyebrow mb-3">Explore {mapArea.name}</p>
          <h1>Find outdoor fitness equipment.</h1>
          <p className="mt-3 max-w-2xl muted md:text-lg">See what’s nearby, check what’s been verified, and tell us what’s missing.</p></div>
        <p className="border-l-2 border-brand pl-4 text-sm muted">Demo equipment is concentrated in {pilot.name}. Check site details before visiting.</p>
      </div>
    </section>
    <div className="shell space-y-5 py-6">
      <form className="panel grid grid-cols-2 items-end gap-3 md:grid-cols-[1fr_1.5fr_auto]" onSubmit={submit}>
        <Field label="Equipment type"><Categories all value={category} onChange={setCategory}/></Field>
        <Field label="Site or park name"><input maxLength={limits.shortText} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name"/></Field>
        <button className="button primary col-span-2 md:col-span-1">Find equipment</button>
      </form>
      <div className="split">
        <section className="panel space-y-4 xl:col-start-2 xl:row-start-1" aria-labelledby="neighborhood-map">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="neighborhood-map" className="text-lg md:text-xl">Neighborhood map</h2>
            <div className="flex flex-wrap gap-2">
              <button className="button max-md:px-2.5" aria-pressed={pick} onClick={()=>setPick(!pick)}>{pick?'Cancel pin selection':'Set reference pin'}</button>
              {reference && <button className="button" onClick={()=>setReference(null)}>Clear reference</button>}
            </div>
          </div>
          {pick && <p role="status" className="text-sm muted">Click the map to sort listings by approximate straight-line distance.</p>}
          <Suspense fallback={<p>Loading map…</p>}><MapView label="Public equipment map"
            onPick={pick?point=>{setReference(point);setPick(false);}:undefined}
            pins={[...results.map((row,index)=>({...row,label:row.name,kind:'equipment' as const,short:String(index+1),
              selected:row.id===selected,onSelect:()=>{if(!pick)setSelected(row.id);}})),
              ...(reference?[{...reference,kind:'reference' as const,id:'reference',label:'Reference point',short:'•'}]:[])]}/>
          </Suspense>
          {item && <article className="rounded-control border border-line p-4" aria-label="Selected equipment">
            <h3>{item.name}</h3>{item.fixture && <span className="tag">Illustrative demo equipment</span>}<p className="text-sm muted">{categories[item.category]} · {item.park?.name||'Standalone equipment'}</p>
            <dl className="my-4 grid gap-3 text-sm sm:grid-cols-2">
              {Object.entries({Verification:item.fixture&&item.verifiedOn?`Simulated · ${item.verifiedOn}`:item.verifiedOn||'Unverified',Condition:item.condition,
                'Public access':item.access,Hours:item.park?.hours||'Unknown',Source:item.source||'Unknown'})
                .map(([key,value])=><div key={key}><dt className="font-bold">{key}</dt><dd>{value}</dd></div>)}
            </dl>
            <div className="flex flex-wrap gap-2">
              {request && <button className="button" onClick={()=>request(item.category)}>Request this equipment nearby</button>}
              {item.park?.cityMaintained && <a className="button" target="_blank" rel="noreferrer" href={maintenance}>Report a City park problem ↗</a>}
            </div>
          </article>}
        </section>
        <section className="panel xl:col-start-1 xl:row-start-1" aria-labelledby="equipment-listings" aria-busy={loading}>
          <h2 id="equipment-listings">Equipment listings</h2>
          <p className="mb-3 text-sm muted" role="status">{loading?'Loading equipment…':`${results.length} listed locations`}</p>
          <Feedback error={error}/>{error && <button className="button" onClick={()=>setRetry(retry+1)}>Retry search</button>}
          {!error && !loading && !results.length && <p>No matching equipment is listed. Try a different site name or equipment type.</p>}
          <ul className="space-y-2">
            {sorted.map(({item,distance})=><li key={item.id}>
              <button className={`w-full rounded-control border p-3 text-left ${selected===item.id?'border-brand bg-mint':'border-line bg-white hover:bg-canvas'}`}
                onClick={()=>setSelected(item.id)} aria-pressed={selected===item.id}>
                <span className="block font-bold">{item.name}</span>
                <span className="block text-sm muted">{categories[item.category]} · {item.park?.name||'Standalone equipment'}</span>
                <span className={`tag mt-2 ${item.verifiedOn?'':'unverified'}`}>{item.fixture && item.verifiedOn?'Simulated verification':item.verifiedOn?'Verification recorded':'Unverified'}</span>
                {item.access!=='public' && <span className="tag unverified ml-2">{item.access==='restricted'?'Restricted access':'Public access unknown'}</span>}
                {item.fixture && <span className="ml-2 text-xs muted">Illustrative demo equipment</span>}
                {distance!==null && <span className="ml-2 text-xs muted">{Math.round(distance)} m straight-line</span>}
              </button>
            </li>)}
          </ul>
        </section>
      </div>
      {request && <section className="panel flex flex-wrap items-center justify-between gap-4">
        <div><h2>Missing something nearby?</h2><p className="muted">Your request can inform future investment comparisons.</p></div>
        <button className="button primary" onClick={()=>request(category||item?.category||'pull-up')}>Request equipment nearby</button>
      </section>}
    </div>
  </main>;
}
