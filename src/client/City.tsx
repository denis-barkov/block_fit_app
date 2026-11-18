import { lazy,Suspense,useEffect,useState, type FormEvent } from 'react';
import { categories,pilot,planning } from '../../config/settings';
import type { Category, Explanation, Scenario } from '../contracts';
import { interpretation,type Comparison } from '../server/planning';
import { api,Categories,Feedback,Field,message,useAction } from './common';
import CityInventory,{type Inventory} from './CityInventory';

const MapView=lazy(()=>import('./Map'));
const dollars=(amount:number|null)=>amount===null?'N/A':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount/100);
type Result=Comparison&{explanation?:Explanation};
const initial:Scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
export default function City() {
  const [inventory,setInventory]=useState<Inventory>();
  const [scenario,setScenario]=useState<Scenario>(initial);
  const [result,setResult]=useState<Result>();
  const [loadError,setLoadError]=useState('');
  const [focused,setFocused]=useState('');
  const action=useAction();
  const report=useAction();
  const ai=useAction();
  async function load() {
    setInventory(await api<Inventory>('/staff/inventory'));
    setLoadError('');
  }
  useEffect(()=>{
    void Promise.all([load(),api<Result>('/staff/compare','POST',initial).then(setResult)])
      .catch(error=>setLoadError(message(error)));
  },[]);
  async function refresh() {
    await load();
    setScenario(current=>({...current,selected:[]}));
    setResult(undefined);
  }
  function apply(event:FormEvent) {
    event.preventDefault();
    void action.run(async()=>setResult(await api<Result>('/staff/compare','POST',scenario)),'Comparison updated.');
  }
  const applied=result?.scenario;
  const current=applied && applied.category===scenario.category && applied.radius===scenario.radius &&
    applied.budget===scenario.budget && applied.horizon===scenario.horizon &&
    applied.selected.join(',')===scenario.selected.join(',') ? result ?? null : null;
  const requestRef=current && {scenario:current.scenario,revision:current.revision,calculatedAt:current.calculatedAt};
  const choices=inventory?.candidates.filter(site=>site.category===scenario.category && site.feasibility!=='excluded')??[];
  const select=(category:Category|'')=>{if(category)setScenario({...scenario,category,selected:[]});};
  const pins=current ? [
    ...current.existing.map((point,index)=>({...point,id:`e${index}`,kind:'equipment' as const,label:'Verified public equipment',short:'E'})),
    ...current.origins.map((point,index)=>({...point,id:`d${index}`,kind:point.synthetic?'synthetic' as const:'private' as const,
      label:point.synthetic?'Synthetic demand origin':'Private demand origin'})),
    ...current.sites.map((site,index)=>({...site,label:site.name,kind:'candidate' as const,short:String(index+1),
      selected:site.id===focused,onSelect:()=>setFocused(site.id)})),
  ]:[];
  const focus=current?.sites.find(site=>site.id===focused);
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">City workspace · {pilot.name}</p><h1>Where could investment improve access?</h1>
      <p className="mt-2 max-w-3xl muted">Compare candidate sites against recorded equipment demand, existing coverage, an upfront budget, and ongoing costs.</p></header>
    <Feedback error={loadError}/>
    {loadError && <button className="button" onClick={()=>void load().catch(error=>setLoadError(message(error)))}>Retry inventory</button>}
    {!inventory && !loadError && <p role="status">Loading staff inventory…</p>}
    <div className="split">
      <form className="panel space-y-3" onSubmit={apply}>
        <h2>Comparison inputs</h2>
        <Field label="Equipment type"><Categories onChange={select} value={scenario.category}/></Field>
        <Field label="Straight-line radius (m)"><input type="number" min={planning.minRadius} max={planning.maxRadius}
          value={Number.isNaN(scenario.radius)?'':scenario.radius} required onChange={e=>setScenario({...scenario,radius:e.target.valueAsNumber})}/></Field>
        <Field label="Upfront budget (USD)"><input type="number" step=".01" min="0" max={planning.maxBudget/100}
          value={Number.isNaN(scenario.budget)?'':scenario.budget/100} required onChange={e=>setScenario({...scenario,budget:Math.round(e.target.valueAsNumber*100)})}/></Field>
        <Field label="Planning horizon (years)"><input type="number" min="1" max={planning.maxHorizon}
          value={Number.isNaN(scenario.horizon)?'':scenario.horizon} required onChange={e=>setScenario({...scenario,horizon:e.target.valueAsNumber})}/></Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-bold">Combine up to {planning.combination} sites</legend>
          {!choices.length && <p className="text-sm muted">No eligible sites for this equipment type.</p>}
          {choices.map(site=><label key={site.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={scenario.selected.includes(site.id)}
              disabled={scenario.selected.length>=planning.combination&&!scenario.selected.includes(site.id)}
              onChange={e=>setScenario({...scenario,selected:e.target.checked?[...scenario.selected,site.id]:scenario.selected.filter(id=>id!==site.id)})}/>
            {site.name}</label>)}
        </fieldset>
        <button className="button primary" disabled={action.busy}>Compare sites</button><Feedback {...action}/>
      </form>
      <section className="panel space-y-3"><h2>Demand and coverage</h2>
        <p className="text-sm muted">Straight-line coverage does not reflect walking routes. Private demand pins are visible only to staff.</p>
        <Suspense fallback={<p>Loading map…</p>}><MapView label="Staff coverage map" pins={pins}
          overlays={current?[...current.existing,...current.sites.filter(site=>site.feasibility!=='excluded')].map(point=>({point,radius:current.scenario.radius})):[]}/></Suspense>
        <ul className="flex flex-wrap gap-3 text-sm muted">
          <li><span className="font-bold text-brand">E</span> Verified usable public equipment</li><li><span className="font-bold text-ink">1</span> Candidate</li>
          <li><span className="font-bold text-amber">●</span> Synthetic demand</li><li><span className="font-bold text-danger">●</span> Private demand</li>
          <li><span className="font-bold text-brand">◯</span> Approximate coverage</li>
        </ul>
        {current && <div className="flex flex-wrap gap-2">{current.sites.map(site=><button key={site.id} className="button"
          aria-pressed={site.id===focused} onClick={()=>setFocused(site.id)}>{site.name}</button>)}</div>}
        {focus && <div className="rounded-control border border-line p-3"><h3>{focus.name}</h3><p className="muted">{focus.notes||'No site notes.'}</p>
          {focus.projectUrl && <a href={focus.projectUrl} target="_blank" rel="noreferrer" className="font-bold text-brand">Public project reference ↗</a>}</div>}
      </section>
    </div>
    <section className="panel space-y-4">
      <div className="flex flex-wrap justify-between gap-3"><div><h2>Investment comparison</h2>
        {current && <p className="text-sm muted">Revision {current.revision} · {new Date(current.calculatedAt).toLocaleString()}</p>}</div>
        <div className="flex flex-wrap gap-2">{requestRef && <><button className="button" disabled={ai.busy} onClick={()=>void ai.run(async()=>{
          const explanation=await api<Explanation>('/staff/explain','POST',requestRef);
          setResult(value=>value?.calculatedAt===requestRef.calculatedAt?{...value,explanation}:value);
        })}>{ai.busy?'Preparing explanation…':'Request AI explanation'}</button>
          <button className="button primary" disabled={report.busy} onClick={()=>void report.run(async()=>{
            const text=await api<string>('/staff/export','POST',requestRef);
            const url=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));
            const anchor=document.createElement('a');anchor.href=url;anchor.download='blockfit-comparison.md';anchor.click();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          },'Comparison brief downloaded.')}>Download brief</button></>}</div>
      </div>
      <Feedback {...report}/><Feedback {...ai}/>
      {current ? <>
        <p><strong>{current.unmet}</strong> of <strong>{current.demandCount}</strong> recorded requesters lack verified coverage.</p>
        {!current.options.length && <p>No active candidates for this category.</p>}
        {!!current.options.length && <div className="overflow-x-auto" tabIndex={0} aria-label="Comparison results table">
          <table className="preview-table"><thead><tr>
            <th scope="col">Option</th><th scope="col">Newly covered</th><th scope="col">Upfront / budget fit</th>
            <th scope="col">Lifecycle</th><th scope="col">Lifecycle per requester</th><th scope="col">Feasibility</th>
          </tr></thead><tbody>{current.options.map(option=>{
            const key=option.ids.join(',');
            return <tr key={key}>
              <td><strong>{option.ids.map(id=>current.sites.find(site=>site.id===id)?.name).join(' + ')}</strong>
                {current.highlighted.includes(key) && <p className="mt-1 text-xs font-bold text-brand">Lowest modeled cost per newly covered requester</p>}
                {!!option.missing.length && <p className="mt-1 text-xs muted">Unknown: {[...new Set(option.missing.map(x=>x.key))].join(', ')}</p>}</td>
              <td>{option.count}</td>
              <td>{dollars(option.estimates.base.upfront)}<br/>{option.estimates.base.fits===null?'Unknown':option.estimates.base.fits?'Within budget':'Over budget'}
                {option.estimates.high.fits===false && <p className="text-xs text-amber">High estimate exceeds budget</p>}
                <p className="text-xs muted">{dollars(option.estimates.low.upfront)} – {dollars(option.estimates.high.upfront)}</p></td>
              <td>{dollars(option.estimates.base.lifecycle)}<p className="text-xs muted">{dollars(option.estimates.low.lifecycle)} – {dollars(option.estimates.high.lifecycle)}</p></td>
              <td>{dollars(option.estimates.base.perRequester)}</td><td>{option.feasibility.replaceAll('-',' ')}</td>
            </tr>;
          })}</tbody></table>
        </div>}
        <p className="text-sm muted">Values show base costs with low-to-high ranges. The upfront budget covers initial investment. {interpretation}</p>
        {current.explanation && <article className="rounded-control bg-canvas p-4"><h3>AI explanation</h3>
          {Object.entries(current.explanation).map(([key,value])=><p className="mt-2 break-words text-sm" key={key}><strong>{key[0].toUpperCase()+key.slice(1)}.</strong> {value}</p>)}</article>}
      </>:<p role="status" className="muted">Run the comparison to see results for the current inputs and inventory.</p>}
    </section>
    {inventory && <CityInventory data={inventory} refresh={refresh}/>}
  </main>;
}
