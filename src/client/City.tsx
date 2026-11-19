import { Download } from 'lucide-react';
import { mapArea } from '../../config/map-area';
import { lazy,Suspense,useEffect,useState, type FormEvent } from 'react';
import { categories,planning } from '../../config/settings';
import type { Category, Explanation, Scenario } from '../contracts';
import { feasibilityLabels,interpretation,newlyCovered,ranking,screening,type Comparison } from '../server/planning';
import { api,Categories,Feedback,Field,InfoHint,message,useAction } from './common';
import CityInventory,{type Inventory} from './CityInventory';

const MapView=lazy(()=>import('./Map'));
const dollars=(amount:number|null)=>amount===null?'N/A':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount/100);
type Result=Comparison&{explanation?:Explanation};
const initial:Scenario={category:'pull-up',radius:planning.radius,horizon:planning.horizon,budget:planning.budget,selected:[]};
function InventoryPage() {
  const [inventory,setInventory]=useState<Inventory>();
  const [error,setError]=useState('');
  async function load() {
    setInventory(await api<Inventory>('/staff/inventory'));
    setError('');
  }
  const retry=()=>void load().catch(error=>setError(message(error)));
  useEffect(retry,[]);
  return <main className="shell space-y-5 py-8">
    <h1>Manage inventory</h1>
    <Feedback error={error}/>
    {error && <button className="button" onClick={retry}>Retry inventory</button>}
    {inventory ? <CityInventory data={inventory} refresh={load}/> : !error && <p role="status">Loading staff inventory…</p>}
  </main>;
}

export default function City({inventoryOnly,testWorkspace}: {inventoryOnly:boolean;testWorkspace:boolean}) {
  return inventoryOnly?<InventoryPage/>:<ComparisonPage testWorkspace={testWorkspace}/>;
}

function ComparisonPage({testWorkspace}: {testWorkspace:boolean}) {
  const [scenario,setScenario]=useState<Scenario>(initial);
  const [result,setResult]=useState<Result>();
  const [focused,setFocused]=useState('');
  const action=useAction();
  const report=useAction();
  const ai=useAction();
  async function calculate(value:Scenario) {setResult(await api<Result>('/staff/compare','POST',value));}
  useEffect(()=>{void action.run(()=>calculate(initial));},[]);
  function apply(event:FormEvent) {
    event.preventDefault();
    void action.run(async()=>calculate(scenario),'Comparison updated.');
  }
  const applied=result?.scenario;
  const current=applied && applied.category===scenario.category && applied.radius===scenario.radius &&
    applied.budget===scenario.budget && applied.horizon===scenario.horizon &&
    applied.selected.join(',')===scenario.selected.join(',') ? result ?? null : null;
  const requestRef=current && {scenario:current.scenario,revision:current.revision,calculatedAt:current.calculatedAt};
  const inspected=result?.scenario.category===scenario.category?result:undefined;
  const choices=inspected?.sites??[];
  const select=(category:Category|'')=>{
    if(!category)return;
    const updated={...scenario,category,selected:[]};
    setScenario(updated);setFocused('');
    if(Number.isFinite(updated.radius)&&Number.isFinite(updated.horizon)&&Number.isFinite(updated.budget)) {
      void action.run(()=>calculate(updated));
    }
  };
  const selectCandidate=(id:string)=>setFocused(id);
  const toggle=(id:string)=>{
    setFocused(id);
    setScenario(current=>({...current,selected:current.selected.includes(id)
      ?current.selected.filter(selected=>selected!==id)
      :current.selected.length<planning.combination?[...current.selected,id]:current.selected}));
  };
  const label=(id:string)=>`Site ${choices.findIndex(site=>site.id===id)+1} · ${choices.find(site=>site.id===id)?.name??id}`;
  const pins=inspected ? [
    ...inspected.existing.map((point,index)=>({...point,id:`e${index}`,kind:'equipment' as const,
      label:point.fixture?'Demo equipment with simulated verification':'Verified usable public equipment',short:'E'})),
    ...inspected.origins.map((point,index)=>({...point,id:`d${index}`,kind:point.synthetic?'synthetic' as const:'private' as const,
      covered:point.covered,label:`${point.synthetic?'Synthetic':'Private'} demand origin · ${point.covered?'already covered':'unmet'}`})),
    ...choices.map((site,index)=>({...site,label:label(site.id),kind:'candidate' as const,short:String(index+1),
      selected:site.id===focused,onSelect:()=>selectCandidate(site.id)})),
  ]:[];
  const focus=choices.find(site=>site.id===focused);
  const focusSelected=!!focus && scenario.selected.includes(focus.id);
  return <main className="shell space-y-5 py-8">
    <header><p className="eyebrow">City workspace · {mapArea.name}</p><h1>Where could investment improve access?</h1>
      <p className="mt-2 max-w-3xl muted">Compare candidate sites against recorded equipment demand, existing coverage, an upfront budget, and ongoing costs.</p></header>
    {testWorkspace && <p className="tag">Isolated automated-test workspace</p>}
    <div className="split">
      <form id="comparison-assumptions" aria-labelledby="comparison-assumptions-heading" className="panel space-y-3" onSubmit={apply}>
        <h2 id="comparison-assumptions-heading">1. Equipment and assumptions</h2>
        <div className="field-grid grid-cols-2 items-end xl:grid-cols-1">
          <Field label="Equipment type"><select disabled={action.busy} value={scenario.category} onChange={event=>select(event.target.value as Category)}>{Object.entries(categories).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></Field>
          <Field label="Straight-line radius (m)"><input type="number" min={planning.minRadius} max={planning.maxRadius}
            value={Number.isNaN(scenario.radius)?'':scenario.radius} required onChange={e=>setScenario({...scenario,radius:e.target.valueAsNumber})}/></Field>
          <Field label="Upfront budget (USD)"><input type="number" step=".01" min="0" max={planning.maxBudget/100}
            value={Number.isNaN(scenario.budget)?'':scenario.budget/100} required onChange={e=>setScenario({...scenario,budget:Math.round(e.target.valueAsNumber*100)})}/></Field>
          <Field label="Planning horizon (years)"><input type="number" min="1" max={planning.maxHorizon}
            value={Number.isNaN(scenario.horizon)?'':scenario.horizon} required onChange={e=>setScenario({...scenario,horizon:e.target.valueAsNumber})}/></Field>
        </div>
        <button className="button" disabled={action.busy}>Apply assumptions</button><Feedback {...action}/>
      </form>
      <section className="panel space-y-3"><h2>2. Inspect unmet demand</h2>
        {inspected && <p className="font-bold">{categories[inspected.scenario.category]} · {inspected.scenario.radius} m straight-line radius</p>}
        {inspected && <p><strong>{inspected.demandCount-inspected.unmet} already covered</strong> · <strong>{inspected.unmet} unmet</strong> · {inspected.demandCount} recorded requesters
          {inspected.origins.some(origin=>origin.synthetic) && <> · {inspected.origins.filter(origin=>origin.synthetic).length} synthetic</>}</p>}
        <p className="text-sm muted">Distances are straight-line approximations. Private demand pins are restricted to staff.</p>
        <Suspense fallback={<p>Loading map…</p>}><MapView label="Staff coverage map" pins={pins} overview
          overlays={inspected?[...inspected.existing,...choices.filter(site=>site.feasibility!=='excluded')].map(point=>({point,radius:inspected.scenario.radius})):[]}/></Suspense>
        <ul className="flex flex-wrap gap-3 text-sm muted">
          <li><span className="font-bold text-brand">● E</span> Eligible equipment</li>
          <li><span className="font-bold text-ink">■ 1</span> Numbered candidate</li>
          <li><span className="font-bold text-amber">◆</span> Synthetic demand</li>
          <li><span className="font-bold text-danger">●</span> Private demand</li>
          <li><span className="font-bold">Outline</span> Already covered</li>
          <li><span className="font-bold">Filled</span> Unmet demand</li>
          <li><span className="font-bold text-brand">◯</span> Approximate coverage</li>
          <li>Demo equipment uses simulated verification</li>
        </ul>
        {!!choices.length && <div className="flex flex-wrap gap-2" aria-label="Candidate map alternative">{choices.map(site=><button key={site.id} className="button"
          aria-pressed={site.id===focused} onClick={()=>selectCandidate(site.id)}>{label(site.id)}</button>)}</div>}
        {focus && <article className="space-y-2 rounded-control border border-line p-3" aria-label="Candidate details">
          <h3>{label(focus.id)}</h3>
          <p>{feasibilityLabels[focus.feasibility]}{focus.fixture?' · Illustrative demo candidate':''}</p>
          <p className="muted">{focus.notes||'No site notes.'}</p>
          {focus.feasibility==='excluded' ? <p>Visible for review. This site cannot join a combination.</p> :
            <button className="button" aria-pressed={focusSelected} disabled={!focusSelected&&scenario.selected.length>=planning.combination}
              onClick={()=>toggle(focus.id)}>{focusSelected?'Remove from combination':'Add to combination'}</button>}
          {focus.projectUrl && <a href={focus.projectUrl} target="_blank" rel="noreferrer" className="block font-bold text-brand">Public project reference ↗</a>}
        </article>}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-bold">3. Select up to {planning.combination} sites</legend>
          {!choices.some(site=>site.feasibility!=='excluded') && <p className="text-sm muted">No selectable sites for this equipment type. Apply the assumptions to refresh.</p>}
          {choices.filter(site=>site.feasibility!=='excluded').map(site=><label key={site.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={scenario.selected.includes(site.id)}
              disabled={scenario.selected.length>=planning.combination&&!scenario.selected.includes(site.id)}
              onChange={()=>toggle(site.id)}/>
            {site.name}</label>)}
        </fieldset>
        <button type="submit" form="comparison-assumptions" className="button primary" disabled={action.busy}>Compare sites</button>
      </section>
    </div>
    <section className="panel space-y-4" aria-labelledby="comparison-heading">
      <div className="flex flex-wrap justify-between gap-3"><div><InfoHint label="How this comparison works" content={<>
        <p>{newlyCovered}</p>
        <p>{screening} {ranking}</p>
        <p>Upfront budget fit is separate from lifecycle costs. Missing amounts remain unknown. Zero new coverage yields N/A for cost per requester. {interpretation}</p>
      </>}><h2 id="comparison-heading">4. Compare investment options</h2></InfoHint>
        {current && <p className="text-sm muted">Revision {current.revision} · {new Date(current.calculatedAt).toLocaleString()}</p>}</div>
        <div className="flex flex-wrap gap-2 md:ml-auto md:justify-end">{requestRef && <>
          <button className="button primary gap-2" disabled={report.busy} onClick={()=>void report.run(async()=>{
            const text=await api<string>('/staff/export','POST',requestRef);
            const url=URL.createObjectURL(new Blob([text],{type:'text/markdown'}));
            const anchor=document.createElement('a');anchor.href=url;anchor.download='blockfit-comparison.md';anchor.click();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          },'Comparison brief downloaded.')}><Download className="action-icon" aria-hidden="true"/> Download brief</button>
          {!testWorkspace && <button className="button" disabled={ai.busy||action.busy} onClick={()=>void ai.run(async()=>{
            const explanation=await api<Explanation>('/staff/explain','POST',requestRef);
            setResult(value=>value?.calculatedAt===requestRef.calculatedAt?{...value,explanation}:value);
          })}>{ai.busy?'Preparing explanation…':'Request AI explanation'}</button>}
        </>}<span className="sr-only" role="status">{current && ai.busy?'Preparing explanation…':''}</span></div>
      </div>
      {(report.status || report.error || (current && ai.error)) && <div className="md:text-right">
        <Feedback {...report}/>
        {current && <Feedback error={ai.error}/>}
      </div>}
      {current?.explanation && !action.busy && !ai.busy && <article className="rounded-control bg-canvas p-4 md:max-xl:ml-auto md:max-xl:max-w-2xl" aria-labelledby="explanation-heading">
        <h3 id="explanation-heading">AI explanation</h3>
        <p className="mt-2 break-words text-sm">{current.explanation.summary}</p>
        {current.explanation.tradeoffs && <p className="mt-2 break-words text-sm"><strong>Tradeoffs.</strong> {current.explanation.tradeoffs}</p>}
        {current.explanation.checks && <p className="mt-2 break-words text-sm"><strong>Checks before proceeding.</strong> {current.explanation.checks}</p>}
      </article>}
      {current ? <>
        {!current.highlighted.length && <p className="text-sm muted">No option meets all highlighting criteria.</p>}
        {!current.options.length && <p>No active candidates for this category.</p>}
        {!!current.options.length && <div className="overflow-x-auto" tabIndex={0} aria-label="Comparison results table">
          <table className="preview-table"><thead><tr>
            <th scope="col">Option</th><th scope="col">Newly covered</th><th scope="col">Upfront / budget fit</th>
            <th scope="col">Lifecycle</th><th scope="col">Lifecycle per requester</th><th scope="col">Feasibility</th>
          </tr></thead><tbody>{current.options.map(option=>{
            const key=option.ids.join(',');
            return <tr key={key}>
              <td>{option.ids.length===1 ?
                <button type="button" className="text-left font-bold underline" aria-pressed={focused===option.ids[0]}
                  onClick={()=>selectCandidate(option.ids[0])}>{label(option.ids[0])}</button> :
                <strong>{option.ids.map(id=>label(id)).join(' + ')}</strong>}
                {option.ids.some(id=>current.sites.find(site=>site.id===id)?.fixture) && <p className="text-xs muted">Illustrative demo assumptions</p>}
                {current.highlighted.includes(key) && <p className="mt-1 text-xs font-bold text-brand">Lowest modeled cost per newly covered requester</p>}
                {!!option.missing.length && <p className="mt-1 text-xs muted">Unknown: {[...new Set(option.missing.map(x=>x.key))].join(', ')}</p>}</td>
              <td>{option.count}{option.ids.length>1 && <p className="text-xs muted">{option.overlap} in overlapping radii, counted once</p>}</td>
              <td>{dollars(option.estimates.base.upfront)}<br/>{option.estimates.base.fits===null?'Unknown':option.estimates.base.fits?'Within budget':'Over budget'}
                {option.estimates.high.fits===false && <p className="text-xs text-amber">High estimate exceeds budget</p>}
                <p className="text-xs muted">{dollars(option.estimates.low.upfront)} – {dollars(option.estimates.high.upfront)}</p></td>
              <td>{dollars(option.estimates.base.lifecycle)}<p className="text-xs muted">{dollars(option.estimates.low.lifecycle)} – {dollars(option.estimates.high.lifecycle)}</p></td>
              <td>{dollars(option.estimates.base.perRequester)}</td><td>{feasibilityLabels[option.feasibility]}</td>
            </tr>;
          })}</tbody></table>
        </div>}

      </>:<p role="status" className="muted">Run the comparison to see results for the current inputs and inventory.</p>}
    </section>
  </main>;
}
