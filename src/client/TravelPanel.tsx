import { Sparkles } from 'lucide-react';
import { useEffect,useRef,useState } from 'react';
import { travel } from '../../config/travel';
import type { Category, Coordinate, PublicEquipment } from '../contracts';
import { approxDistance, byDistance, distanceNotice, mapNotice, originEndpoint, reasonText, type TravelResponse, type TravelSuggestion } from '../travel';
import { Feedback,message,Modal,sessionExpiredEvent,useTransientNotice } from './common';
import type { CollectEvidence, Endpoints } from './map-evidence';
import DestinationActions,{mapsHandoff} from './DestinationActions';

type Props={
  category:Category|'';query:string;origin:Coordinate|null;sites:PublicEquipment[];target:PublicEquipment|null;
  role:'resident'|'staff'|null; collect?:CollectEvidence;close:()=>void;chooseOrigin:()=>void;signIn:()=>void;
  onChoose:(option:TravelSuggestion)=>void;
};

export default function TravelPanel({category,query,origin,sites,target,role,collect,close,chooseOrigin,signIn,onChoose}:Props) {
  const [reply,setReply]=useState<TravelResponse>();
  const [phase,setPhase]=useState<'collecting'|'generating'|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useTransientNotice();
  const pending=useRef<AbortController|null>(null);
  const knownSites=new Map(sites.map(site=>[site.id,site]));
  const current=target;
  const shortlist=reply?.options ?? [];
  const prepared=shortlist.find(option=>option.id===current?.id);
  const modeCategory=current?.category??category;
  const matches=sites.filter(site=>site.category===modeCategory);
  const ranked=origin?byDistance(matches,origin):[];
  const distances=new Map(ranked.map(({site,distance})=>[site.id,distance]));
  useEffect(()=>()=>pending.current?.abort(),[]);

  async function generate() {
    if(!origin||!modeCategory||role!=='resident'||!ranked.length||pending.current) return;
    const controller=new AbortController();
    pending.current=controller;
    setPhase('collecting');setError('');setNotice('');
    try {
      const endpoints:Endpoints={[originEndpoint]:origin,...Object.fromEntries(ranked.slice(0,travel.pool).map(({site})=>[site.id,site]))};
      if(current) endpoints[current.id]=current;
      const observations=await collect?.(endpoints,controller.signal) ?? {};
      if(controller.signal.aborted) return;
      setPhase('generating');
      const response=await fetch('/api/resident/travel',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({category:modeCategory,query,origin,target:current?.id??null,observations})});
      if(!response.ok) {
        const problem=await response.json().catch(()=>null) as {error?:string}|null;
        if(response.status===401) window.dispatchEvent(new Event(sessionExpiredEvent));
        throw new Error(problem?.error||'Suggestions could not be generated.');
      }
      const data=await response.json() as TravelResponse;
      if(!controller.signal.aborted) {
        setReply(data);
        if(data.cached)setNotice('Reused a saved suggestion for this search.');
      }
    } catch(error) {if(!controller.signal.aborted) setError(message(error));}
    finally {
      if(!controller.signal.aborted) setPhase(null);
      pending.current=null;
    }
  }

  function details(site:PublicEquipment) {
    const distance=distances.get(site.id);
    return <p className="text-sm muted">
      {distance!==undefined && <><strong className="text-ink">Approx. distance {approxDistance(distance)}</strong> · </>}
      {site.categoryName} · {site.condition} · Public access
    </p>;
  }

  return <Modal title={current?'Explore this location':'Help me choose'} onClose={close}
    help={{label:'About travel suggestions',content:<>
      <p>{mapNotice}</p>
      {origin && <p>{distanceNotice}</p>}
      {current&&<p>{mapsHandoff}</p>}
    </>}}>
    <div className="space-y-3">
      {!role && <>
        <p>Get a short comparison of equipment locations using your reference pin.</p>
        <button className="button primary" onClick={signIn}>Sign in or create an account to explore suggestions.</button>
      </>}
      {role==='staff' && <p className="text-sm muted">AI suggestions are available to signed-in residents.</p>}
      {!origin && <div className="space-y-2">
        <p>Set a reference pin to compare distances from your starting point.</p>
        <button className="button" onClick={chooseOrigin}>Set reference pin</button>
      </div>}
      {!modeCategory && <p>Choose an equipment type in search to compare locations.</p>}
      {modeCategory && !matches.length && <p>No eligible matching equipment is listed. You can request equipment from the search page.</p>}
      {current && <article className="rounded-control border border-line p-3 space-y-2">
        <h3>{current.name}</h3>{details(current)}
        {prepared && <p>{reasonText[prepared.reason]}</p>}
        <DestinationActions key={current.id} site={current}/>
      </article>}
      {!current && shortlist.map(option=>{
        const site=knownSites.get(option.id);
        return site && <article key={site.id} className="rounded-control border border-line p-3 space-y-2">
          <h3>{site.name}</h3>{details(site)}<p>{reasonText[option.reason]}</p>
          <button type="button" className="button" onClick={()=>onChoose(option)}>Show on map<span className="sr-only"> {site.name}</span></button>
        </article>;
      })}
      {reply && !shortlist.length && <p>No eligible matching locations were available when checked.</p>}
      {notice && <p role="status" className="text-sm muted">{notice}</p>}
      {reply && <p className="text-sm muted">{reply.evidence==='unavailable'?'No landmarks found in the inspected map data.':'Mapped landmarks are based on partial map coverage.'}</p>}
      {role==='resident' && origin && ranked.length>0 && !prepared && (!reply || !!current) &&
        <button className="button primary gap-2" disabled={phase!==null} onClick={()=>void generate()}>
          <Sparkles className="action-icon" aria-hidden="true"/>
          {current?'Generate suggestion':'Generate suggestions'}
        </button>}
      {phase && <p role="status">{phase==='collecting'?'Checking available map landmarks…':'Generating suggestions…'}</p>}
      <Feedback error={error}/>
    </div>
  </Modal>;
}
