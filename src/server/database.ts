import { limits } from '../../config/settings';
import type { Candidate, Demand, Equipment, Park, PublicEquipment, Scenario } from '../contracts';
import { compare, type Comparison, type DemandOrigin } from './planning';

type Bind = string | number | null;
export const stmt = (db: D1Database, sql: string, ...values: Bind[]) => db.prepare(sql).bind(...values);
export async function rows<T>(db: D1Database, sql: string, ...values: Bind[]) {
  return (await stmt(db,sql,...values).all<T>()).results;
}

const equipmentColumns = `e.id,e.name,e.category,e.lat,e.lng,e.park_id AS parkId,e.condition,e.access,
  e.source,e.verified_on AS verifiedOn,e.visible`;
const parkColumns = 'id,name,lat,lng,external_id AS externalId,source,hours,city_maintained AS cityMaintained';
const candidateColumns = 'id,name,category,lat,lng,park_id AS parkId,feasibility,costs,notes,project_url AS projectUrl';
type EquipmentRow = Omit<Equipment,'visible'> & { visible: number };
type CandidateRow = Omit<Candidate,'costs'> & { costs: string };
const candidate = (row: CandidateRow): Candidate => ({...row,costs:JSON.parse(row.costs)});
const usable = "e.visible=1 AND e.archived=0 AND e.access='public' AND e.condition='usable' AND e.verified_on IS NOT NULL";

export async function inventory(db: D1Database, category: string | null, search: string) {
  const result = await rows<Omit<PublicEquipment,'park'> & { parkName: string | null; hours: string | null; cityMaintained:number|null }>(db,
    `SELECT e.id,e.name,e.category,e.lat,e.lng,e.condition,e.access,e.source,e.verified_on AS verifiedOn,
      p.name AS parkName,p.hours,p.city_maintained AS cityMaintained FROM equipment e LEFT JOIN parks p ON p.id=e.park_id AND p.archived=0
      WHERE e.archived=0 AND e.visible=1 AND (? IS NULL OR e.category=?)
      AND (instr(lower(e.name),lower(?))>0 OR instr(lower(p.name),lower(?))>0)
      ORDER BY e.name,e.id LIMIT ?`, category,category,search,search,limits.inventory);
  return result.map(({parkName,hours,cityMaintained,...equipment}) => ({
    ...equipment, park: parkName ? { name: parkName, hours: hours ?? '', cityMaintained:!!cityMaintained } : null,
  }));
}

export async function staffInventory(db: D1Database) {
  const [parks,equipment,candidates] = await db.batch([
    stmt(db,`SELECT ${parkColumns} FROM parks WHERE archived=0 ORDER BY name LIMIT ?`,limits.inventory),
    stmt(db,`SELECT ${equipmentColumns} FROM equipment e WHERE archived=0 ORDER BY name LIMIT ?`,limits.inventory),
    stmt(db,`SELECT ${candidateColumns} FROM candidates WHERE archived=0 ORDER BY name LIMIT ?`,limits.inventory),
  ]);
  return {
    parks: (parks.results as (Omit<Park,'cityMaintained'>&{cityMaintained:number})[]).map(row=>({...row,cityMaintained:!!row.cityMaintained})),
    equipment: (equipment.results as EquipmentRow[]).map(row => ({...row,visible:!!row.visible})),
    candidates: (candidates.results as CandidateRow[]).map(candidate),
  };
}

export async function requests(db: D1Database, owner: string) {
  type RequestRow = Omit<Demand,'point'> & { suggestedLat: number | null; suggestedLng: number | null };
  const result = await rows<RequestRow>(db,`SELECT id,category,lat,lng,status,note,suggestion,
     suggested_lat AS suggestedLat,suggested_lng AS suggestedLng,created_at AS createdAt,confirmed_at AS confirmedAt
     FROM demand WHERE owner=? ORDER BY (status='recorded') DESC,created_at DESC,id LIMIT ?`,owner,limits.inventory);
  return result.map(({suggestedLat, suggestedLng, ...row}) => ({
    ...row, point: suggestedLat !== null && suggestedLng !== null ? {lat:suggestedLat,lng:suggestedLng} : null,
  }));
}

export async function getComparison(db: D1Database, scenario: Scenario): Promise<Comparison | 'limit' | null> {
  // D1 batches run transactionally, so the revision and all records come from the same snapshot.
  const [revision, demand, existing, sites] = await db.batch([
    stmt(db,'SELECT value FROM revision WHERE id=1'),
    stmt(db,`SELECT 'r:'||owner AS id,lat,lng,0 AS synthetic FROM demand WHERE category=? AND status='recorded'
      UNION ALL SELECT 's:'||id AS id,lat,lng,1 AS synthetic FROM synthetic_demand WHERE category=? LIMIT ?`,
      scenario.category,scenario.category,limits.demand+1),
    stmt(db,`SELECT lat,lng,source FROM equipment e WHERE ${usable} AND e.category=? LIMIT ?`,scenario.category,limits.inventory+1),
    stmt(db,`SELECT ${candidateColumns} FROM candidates WHERE archived=0 AND category=? ORDER BY name,id LIMIT ?`,
      scenario.category,limits.inventory+1),
  ]);
  if (demand.results.length > limits.demand || existing.results.length > limits.inventory ||
      sites.results.length > limits.inventory) return 'limit';
  const origins = (demand.results as (Omit<DemandOrigin,'synthetic'> & {synthetic:number})[])
    .map(row => ({...row,synthetic:!!row.synthetic}));
  const equipment = (existing.results as {lat:number;lng:number;source:string}[]);
  const candidates = (sites.results as CandidateRow[]).map(candidate);
  const comparison = compare(scenario,origins,equipment,candidates);
  if (!comparison) return null;
  return {...comparison, scenario, revision:Number((revision.results[0] as {value:number}).value), calculatedAt:new Date().toISOString(),
    sites:candidates, origins:origins.map(({lat,lng,synthetic}) => ({lat,lng,synthetic})),
    existing:equipment.map(({lat,lng}) => ({lat,lng})),
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
