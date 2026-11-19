import { travel } from '../../config/travel';
import { limits } from '../../config/settings';
import type { Candidate, Demand, Equipment, Park, PublicEquipment, Scenario } from '../contracts';
import { compare, type Comparison, type DemandOrigin } from './planning';

type Bind = string | number | null;
export const stmt = (db: D1Database, sql: string, ...values: Bind[]) => db.prepare(sql).bind(...values);
export async function rows<T>(db: D1Database, sql: string, ...values: Bind[]) {
  return (await stmt(db,sql,...values).all<T>()).results;
}

const equipmentColumns = `e.id,e.name,e.category,e.lat,e.lng,e.park_id AS parkId,e.condition,e.access,
  e.source,e.verified_on AS verifiedOn,e.visible,e.fixture`;
const parkColumns = 'id,name,lat,lng,external_id AS externalId,source,hours,city_maintained AS cityMaintained,fixture';
const candidateColumns = 'e.id,e.name,e.category,e.lat,e.lng,e.park_id AS parkId,e.feasibility,e.costs,e.notes,e.project_url AS projectUrl,e.fixture,e.estimated_start AS estimatedStart,e.estimated_ready AS estimatedReady';
const typeReference='t.name AS categoryName,t.active AS categoryActive';
const withType='JOIN equipment_types t ON t.id=e.category';
type EquipmentRow = Omit<Equipment,'visible'|'fixture'|'categoryActive'> & { visible: number; fixture:number; categoryActive:number };
type CandidateRow = Omit<Candidate,'costs'|'fixture'|'categoryActive'> & { costs: string; fixture:number; categoryActive:number };
const candidate = (row: CandidateRow): Candidate => ({...row,costs:JSON.parse(row.costs),fixture:!!row.fixture,categoryActive:!!row.categoryActive});
const usable = "e.visible=1 AND e.archived=0 AND e.access='public' AND e.condition='usable' AND e.verified_on IS NOT NULL";

export async function inventory(db: D1Database, category: string | null, search: string, after?:string, eligibleOnly=false) {
  const result = await rows<Omit<PublicEquipment,'park'|'fixture'|'categoryActive'> & { parkName: string | null; hours: string | null; cityMaintained:number|null; fixture:number;categoryActive:number }>(db,
    `SELECT e.id,e.name,e.category,e.lat,e.lng,e.condition,e.access,e.source,e.verified_on AS verifiedOn,
      t.name AS categoryName,t.active AS categoryActive,e.fixture,p.name AS parkName,p.hours,p.city_maintained AS cityMaintained
      FROM equipment e JOIN equipment_types t ON t.id=e.category LEFT JOIN parks p ON p.id=e.park_id AND p.archived=0
      WHERE ${eligibleOnly?usable+" AND t.active=1":"e.archived=0 AND e.visible=1"} AND (? IS NULL OR (e.category=? AND t.active=1))
      AND (instr(lower(e.name),lower(?))>0 OR instr(lower(p.name),lower(?))>0)
      AND (? IS NULL OR e.id>?)
      ORDER BY ${after===undefined?"e.name,e.id":"e.id"} LIMIT ?`, category,category,search,search,
    after??null,after??null,after===undefined?limits.inventory:travel.pageSize);
  return result.map(({parkName,hours,cityMaintained,fixture,categoryActive,...equipment}) => ({
    ...equipment, categoryActive:!!categoryActive, fixture:!!fixture, park: parkName ? { name: parkName, hours: hours ?? '', cityMaintained:!!cityMaintained } : null,
  }));
}

export async function staffInventory(db: D1Database) {
  const [parks,equipment,candidates] = await db.batch([
    stmt(db,`SELECT ${parkColumns} FROM parks WHERE archived=0 ORDER BY name LIMIT ?`,limits.inventory),
    stmt(db,`SELECT ${equipmentColumns},${typeReference} FROM equipment e ${withType} WHERE e.archived=0 ORDER BY e.name LIMIT ?`,limits.inventory),
    stmt(db,`SELECT ${candidateColumns},${typeReference} FROM candidates e ${withType} WHERE e.archived=0 ORDER BY e.name LIMIT ?`,limits.inventory),
  ]);
  return {
    parks: (parks.results as (Omit<Park,'cityMaintained'|'fixture'>&{cityMaintained:number;fixture:number})[]).map(row=>({...row,cityMaintained:!!row.cityMaintained,fixture:!!row.fixture})),
    equipment: (equipment.results as EquipmentRow[]).map(row => ({...row,visible:!!row.visible,fixture:!!row.fixture,categoryActive:!!row.categoryActive})),
    candidates: (candidates.results as CandidateRow[]).map(candidate),
  };
}

export async function requests(db: D1Database, owner: string, id?:string) {
  type RequestRow = Omit<Demand,'point'|'categoryActive'> & { suggestedLat: number | null; suggestedLng: number | null; categoryActive:number };
  const result = await rows<RequestRow>(db,`SELECT e.id,e.category,e.lat,e.lng,e.status,e.note,e.suggestion,${typeReference},
     e.suggested_lat AS suggestedLat,e.suggested_lng AS suggestedLng,e.created_at AS createdAt,e.confirmed_at AS confirmedAt
     FROM demand e ${withType} WHERE e.owner=? ${id===undefined?'':'AND e.id=?'}
     ORDER BY (e.status='recorded') DESC,e.created_at DESC,e.id LIMIT ?`,owner,...(id===undefined?[]:[id]),id===undefined?limits.inventory:1);
  return result.map(({suggestedLat, suggestedLng, ...row}) => ({
    ...row,categoryActive:!!row.categoryActive, point: suggestedLat !== null && suggestedLng !== null ? {lat:suggestedLat,lng:suggestedLng} : null,
  }));
}

export const comparisonRevisionSQL=(testWorkspace=false)=>testWorkspace
  ?'SELECT value + (SELECT test_revision FROM operations WHERE id=1) AS value FROM revision WHERE id=1'
  :'SELECT value FROM revision WHERE id=1';

export async function getComparison(db: D1Database, scenario: Scenario, testWorkspace=false): Promise<Comparison | 'limit' | 'inactive' | null> {
  // D1 batches run transactionally, so the revision and all records come from the same snapshot.
  const [revision, type, demand, existing, sites] = await db.batch([
    stmt(db,comparisonRevisionSQL(testWorkspace)),
    stmt(db,'SELECT name FROM equipment_types WHERE id=? AND active=1',scenario.category),
    stmt(db,`SELECT 'r:'||d.owner AS id,d.lat,d.lng,0 AS synthetic FROM demand d JOIN user u ON u.id=d.owner
      WHERE d.category=? AND d.status='recorded' AND coalesce(u.purpose='automated-test',0)=?
      UNION ALL SELECT 's:'||id AS id,lat,lng,1 AS synthetic FROM synthetic_demand WHERE category=? AND ?=0 LIMIT ?`,
      scenario.category,Number(testWorkspace),scenario.category,Number(testWorkspace),limits.demand+1),
    stmt(db,`SELECT lat,lng,source,e.fixture FROM equipment e WHERE ${usable} AND (?=0 OR e.fixture=1) AND e.category=? LIMIT ?`,
      Number(testWorkspace),scenario.category,limits.inventory+1),
    stmt(db,`SELECT ${candidateColumns},${typeReference} FROM candidates e ${withType}
      WHERE e.archived=0 AND (?=0 OR e.fixture=1) AND e.category=? ORDER BY e.name,e.id LIMIT ?`,
      Number(testWorkspace),scenario.category,limits.inventory+1),
  ]);
  const categoryName=(type.results[0] as {name:string}|undefined)?.name;
  if(typeof categoryName!=='string') return 'inactive';
  if (demand.results.length > limits.demand || existing.results.length > limits.inventory ||
      sites.results.length > limits.inventory) return 'limit';
  const origins = (demand.results as (Omit<DemandOrigin,'synthetic'> & {synthetic:number})[])
    .map(row => ({...row,synthetic:!!row.synthetic}));
  const equipment = (existing.results as {lat:number;lng:number;source:string;fixture:number}[]);
  const candidates = (sites.results as CandidateRow[]).map(candidate);
  const comparison = compare(scenario,origins,equipment,candidates);
  if (!comparison) return null;
  const {covered,...result}=comparison;
  return {...result, testWorkspace, scenario, categoryName, revision:Number((revision.results[0] as {value:number}).value), calculatedAt:new Date().toISOString(),
    sites:candidates, origins:origins.map(({id,lat,lng,synthetic}) => ({lat,lng,synthetic,covered:covered.has(id)})),
    existing:equipment.map(({lat,lng,fixture}) => ({lat,lng,fixture:!!fixture})),
    inventorySources:[...new Set(equipment.map(pin => pin.source))]};
}

export async function throttle(db: D1Database, key: string, max: number) {
  const window = Math.floor(Date.now() / 600_000);
  const [hit] = await db.batch([
    stmt(db,`INSERT INTO throttle(key,window,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE
      SET attempts=CASE WHEN excluded.window>throttle.window THEN 1 ELSE throttle.attempts+1 END,
          window=max(excluded.window,throttle.window) RETURNING attempts`,key,window),
    stmt(db,'DELETE FROM throttle WHERE key IN (SELECT key FROM throttle WHERE window<? LIMIT 10)',window-144),
  ]);
  return Number((hit.results[0] as {attempts:number}).attempts) <= max;
}
