import { lazy, Suspense, useState, type FormEvent } from 'react';
import { limits,pilot,planning } from '../../config/settings';
import { costKeys, type Candidate, type Coordinate, type Costs, type Equipment, type EquipmentType, type Park } from '../contracts';
import { api,Categories,Coordinates,Feedback,Field,Modal,preferredType,useAction } from './common';

const MapView=lazy(()=>import('./Map'));
const labels={parks:'Parks / areas',equipment:'Existing equipment',candidates:'Candidate sites'};
const singular={parks:'park or area',equipment:'equipment',candidates:'candidate'};
const costNames={equipment:'Equipment purchase',installation:'Installation',preparation:'Site preparation',
  accessibility:'Accessibility',maintenance:'Annual maintenance',replacement:'Replacement cost'};
const levels=['low','base','high'] as const;
export type Inventory={parks:Park[];equipment:Equipment[];candidates:Candidate[]};
type Kind=keyof Inventory;
type Record=Park|Equipment|Candidate;

export default function CityInventory({data,types,refresh}: {data:Inventory;types:EquipmentType[];refresh:()=>Promise<void>}) {
  const [kind,setKind]=useState<Kind>('equipment');
  const [editing,setEditing]=useState<Record|null|undefined>();
  const [archive,setArchive]=useState<Record|null>(null);
  const action=useAction();
  return <section className="panel space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2>Manage inventory</h2>
      <button className="button primary" disabled={kind!=='parks'&&!types.length} onClick={()=>setEditing(null)}>Add {singular[kind]}</button></div>
    <div className="flex flex-wrap gap-2" aria-label="Inventory type">
      {(Object.keys(labels) as Kind[]).map(value=><button key={value} className={`button ${kind===value?'primary':''}`}
        aria-pressed={kind===value} onClick={()=>setKind(value)}>{labels[value]}</button>)}
    </div><Feedback {...action}/>
    {kind!=='parks'&&!types.length && <p>Activate an equipment type before adding a record.</p>}
    {!data[kind].length && <p>No active {labels[kind].toLowerCase()}.</p>}
    <ul className="divide-y divide-line">
      {data[kind].map(record=><li key={record.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div><strong>{record.name}</strong>{record.fixture && <span className="ml-2 tag">Illustrative demo record</span>}{'category' in record && <p className="text-sm muted">
          {record.categoryName}{!record.categoryActive && ' · Type currently unavailable'}</p>}</div>
        <div className="flex gap-2"><button className="button" onClick={()=>setEditing(record)}>Edit<span className="sr-only"> {record.name}</span></button>
          <button className="button" onClick={()=>setArchive(record)}>Archive<span className="sr-only"> {record.name}</span></button></div>
      </li>)}
    </ul>
    {editing!==undefined && <InventoryForm key={editing?.id||kind} kind={kind} record={editing} types={types} parks={data.parks} close={()=>setEditing(undefined)}
      save={async value=>{
        await api(`/staff/inventory/${kind}${editing?`/${editing.id}`:''}`,editing?'PUT':'POST',value);
        await refresh();setEditing(undefined);
        await action.run(async()=>{},'Inventory saved.');
      }}/>}
    {archive && <Modal title={`Archive ${archive.name}?`} onClose={()=>{if(!action.busy)setArchive(null);}}>
      <p className="mb-4 muted">The record will be removed from active inventory and future comparisons.</p>
      <button className="button primary" disabled={action.busy} onClick={()=>void action.run(async()=>{
        await api(`/staff/inventory/${kind}/${archive.id}`,'DELETE');
        await refresh();setArchive(null);
      },'Inventory archived.')}>Confirm archive</button>
      <Feedback error={action.error}/>
    </Modal>}
  </section>;
}

function InventoryForm({kind,record,parks,types,close,save}: {
  kind:Kind;record:Record|null;parks:Park[];types:EquipmentType[];close:()=>void;save:(value:object)=>Promise<void>;
}) {
  const [point,setPoint]=useState<Coordinate>(record?{lat:record.lat,lng:record.lng}:pilot.center);
  const currentType=record&&'category'in record?record:null;
  const [category,setCategory]=useState(currentType?.category??preferredType(types));
  const park=record as Park|null;
  const equipment=record as Equipment|null;
  const candidate=record as Candidate|null;
  const [replacementPlan,setPlan]=useState<Costs['replacementPlan']>(candidate?.costs?.replacementPlan||'unknown');
  const action=useAction();
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    const str=(name:string)=>String(data.get(name)||'');
    const base={name:str('name'),lat:point.lat,lng:point.lng};
    const located={...base,category,parkId:str('parkId')||null};
    if (kind==='parks') {
      void action.run(()=>save({...base,externalId:str('externalId'),source:str('source'),hours:str('hours'),cityMaintained:data.has('cityMaintained')}));
    } else if (kind==='equipment') {
      void action.run(()=>save({...located,condition:str('condition'),access:str('access'),source:str('source'),
        verifiedOn:str('verifiedOn')||null,visible:data.has('visible')}));
    } else {
      void action.run(async()=>{
        const ranges=Object.fromEntries(costKeys.map(key=>{
          const entered=levels.map(level=>str(`${key}-${level}`));
          if (entered.every(value=>value==='') || (key==='replacement' && replacementPlan==='none')) return [key,null];
          if (entered.some(value=>value==='')) throw new Error(`Enter all three ${costNames[key].toLowerCase()} amounts, or leave all blank.`);
          return [key,Object.fromEntries(levels.map((level,index)=>[level,Math.round(Number(entered[index])*100)]))];
        }));
        await save({...located,feasibility:str('feasibility'),notes:str('notes'),projectUrl:str('projectUrl')||null,
          estimatedStart:str('estimatedStart')||null,estimatedReady:str('estimatedReady')||null,
          costs:{...ranges,replacementPlan,interval:replacementPlan==='scheduled'&&str('interval')?Number(str('interval')):null,source:str('costSource')}});
      });
    }
  }
  return <Modal title={`${record?'Edit':'Add'} ${singular[kind]}`} onClose={()=>{if(!action.busy)close();}}>
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Name"><input name="name" defaultValue={record?.name} required maxLength={limits.shortText}/></Field>
      <Suspense fallback={<p>Loading map…</p>}><MapView label="Inventory placement map" initialCenter={record ?? undefined} onPick={setPoint}
        pins={[{...point,id:'placement',kind:'reference',label:'Inventory location pin',short:'•',onMove:setPoint}]}/></Suspense>
      <Coordinates value={point} onChange={setPoint}/>
      {kind==='parks' ? <div className="field-grid">
        <Field label="External ID"><input name="externalId" defaultValue={park?.externalId} maxLength={limits.shortText}/></Field>
        <Field label="Known opening hours"><input name="hours" defaultValue={park?.hours} maxLength={limits.shortText}/></Field>
        <Field label="Source"><textarea name="source" defaultValue={park?.source} maxLength={limits.text}/></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="cityMaintained" defaultChecked={park?.cityMaintained}/> Maintained by NYC Parks</label>
      </div>:<div className="field-grid">
        <Field label="Equipment type"><Categories types={types} value={category} onChange={setCategory} unavailable={currentType?.categoryName}/></Field>
        <Field label="Park or area"><select name="parkId" defaultValue={equipment?.parkId||''}>
          <option value="">None (standalone)</option>{parks.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select></Field>
      </div>}
      {kind==='equipment' && <div className="field-grid">
        <Field label="Condition"><select name="condition" defaultValue={equipment?.condition||'unknown'}>
          <option value="unknown">Unknown</option><option value="usable">Usable</option><option value="unusable">Unusable</option>
        </select></Field>
        <Field label="Public access"><select name="access" defaultValue={equipment?.access||'unknown'}>
          <option value="unknown">Unknown</option><option value="public">Public</option><option value="restricted">Restricted</option>
        </select></Field>
        <Field label="Verification source"><input name="source" defaultValue={equipment?.source} maxLength={limits.text}/></Field>
        <Field label="Verification date"><input name="verifiedOn" type="date" defaultValue={equipment?.verifiedOn||''}/></Field>
        <label className="flex items-center gap-2 text-sm"><input name="visible" type="checkbox" defaultChecked={equipment?.visible??true}/> Show in public listings</label>
      </div>}
      {kind==='candidates' && <>
        <div className="field-grid">
          <Field label="Feasibility"><select name="feasibility" defaultValue={candidate?.feasibility||'unreviewed'}>
            <option value="unreviewed">Unreviewed</option><option value="suitable-for-comparison">Suitable for comparison</option><option value="excluded">Excluded</option>
          </select></Field>
          <Field label="Public City project URL"><input name="projectUrl" type="url" defaultValue={candidate?.projectUrl||''} maxLength={limits.text}/></Field>
        </div>
        <Field label="Site notes"><textarea name="notes" defaultValue={candidate?.notes} maxLength={limits.text}/></Field>
        <p className="text-sm muted">Schedule dates are planning estimates.</p>
        <div className="field-grid">
          <Field label="Estimated start date"><input type="date" name="estimatedStart" defaultValue={candidate?.estimatedStart??''}/></Field>
          <Field label="Estimated ready date"><input type="date" name="estimatedReady" defaultValue={candidate?.estimatedReady??''}/></Field>
        </div>
        <h3>Cost assumptions in USD</h3><p className="text-sm muted">Enter low, base, and high values. Empty ranges are unknown.</p>
        {costKeys.map(key=><fieldset key={key} hidden={key==='replacement'&&replacementPlan==='none'}>
          <legend className="text-sm font-bold">{costNames[key]}</legend>
          <div className="grid grid-cols-3 gap-2">{levels.map(level=><Field key={level} label={level}>
            <input name={`${key}-${level}`} aria-label={`${costNames[key]} ${level}`} type="number" step=".01" min="0"
              max={planning.maxBudget/100} defaultValue={candidate?.costs?.[key]?.[level]===undefined?'':(candidate.costs[key]?.[level]??0)/100}/>
          </Field>)}</div>
        </fieldset>)}
        <div className="field-grid">
          <Field label="Replacement plan"><select name="replacementPlan" value={replacementPlan}
            onChange={e=>setPlan(e.target.value as Costs['replacementPlan'])}>
            <option value="unknown">Unknown</option><option value="none">None planned</option><option value="scheduled">Scheduled</option>
          </select></Field>
          {replacementPlan==='scheduled' && <Field label="Replacement interval (years)">
            <input name="interval" type="number" min="1" max={planning.maxHorizon} defaultValue={candidate?.costs.interval??''}/>
          </Field>}
        </div>
        <Field label="Cost sources"><input name="costSource" defaultValue={candidate?.costs.source} maxLength={limits.text}/></Field>
      </>}
      <button className="button primary" disabled={action.busy}>Save {singular[kind]}</button><Feedback error={action.error}/>
    </form>
  </Modal>;
}
