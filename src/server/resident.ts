import { Hono } from 'hono';
import { catalogLimits } from '../../config/settings';
import { isInServiceArea, pinOutsideServiceArea } from '../../config/map-area';
import { locationInput, moveLocationInput, proposalInput, requestInput, type Coordinate, type SavedLocation } from '../contracts';
import { activeEquipmentType, activeType, existingSubmission, residentCatalog, residentProposals, submitProposal, typeUnavailable } from './catalog';
import { requests, stmt } from './database';
import { suggestTravel } from './resident-travel';
import { body, changed, problem, type App } from './web';

export const resident = new Hono<App>();
resident.route('/',residentCatalog);
resident.post('/travel',suggestTravel);
resident.get('/', async c => {
  const owner = c.get('user').id;
  const [location, history, proposals, count] = await Promise.all([
    stmt(c.env.DB,'SELECT lat,lng,label,use_for_requests AS enabled FROM locations WHERE owner=?',owner)
      .first<Omit<SavedLocation,'useForRequests'>&{enabled:number}>(),
    requests(c.env.DB,owner),
    residentProposals(c.env.DB,owner),
    stmt(c.env.DB,"SELECT count(*) AS count FROM demand WHERE owner=? AND status='recorded'",owner).first<number>('count'),
  ]);
  const saved = location && {lat:location.lat,lng:location.lng,label:location.label,useForRequests:location.enabled===1};
  return c.json({location:saved,requests:history,proposals:proposals.slice(0,catalogLimits.page),
    proposalsNext:proposals.length>catalogLimits.page?catalogLimits.page:null,activeRequests:count??0});
});
resident.get('/requests/:id',async c=>{
  const [item]=await requests(c.env.DB,c.get('user').id,c.req.param('id'));
  if(!item) problem(404,'No matching request was found.');
  return c.json(item);
});
const activeCount = "(SELECT count(*) FROM demand WHERE owner=locations.owner AND status='recorded')";
const changedLocation = 'Your saved location or active requests changed. Close this dialog and refresh My requests.';

resident.put('/location', async c => {
  const {lat,lng,label,useForRequests} = await body(c,locationInput);
  const enabled = useForRequests === undefined ? null : Number(useForRequests);
  const result = await stmt(c.env.DB,`INSERT INTO locations (owner,lat,lng,label,updated_at,use_for_requests)
    VALUES (?,?,?,?,?,coalesce(?,1))
    ON CONFLICT(owner) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at,
      use_for_requests=coalesce(?,locations.use_for_requests)
    WHERE locations.lat=excluded.lat AND locations.lng=excluded.lng`,
    c.get('user').id,lat,lng,label,new Date().toISOString(),enabled,enabled).run();
  changed(result,'Use Move location to change your saved pin.',409);
  return c.json({ok:true});
});
resident.post('/location/move', async c => {
  const {lat,lng,label,useForRequests,activeRequests} = await body(c,moveLocationInput);
  const result = await stmt(c.env.DB,`UPDATE locations SET lat=?,lng=?,label=?,updated_at=?,
    use_for_requests=coalesce(?,use_for_requests) WHERE owner=? AND ${activeCount}=?`,
    lat,lng,label,new Date().toISOString(),useForRequests===undefined?null:Number(useForRequests),
    c.get('user').id,activeRequests).run();
  changed(result,changedLocation,409);
  return c.json({ok:true});
});
resident.delete('/location', async c => {
  const db=c.env.DB;
  const owner=c.get('user').id;
  const [,removed] = await db.batch([
    stmt(db,`INSERT INTO removed_locations(id,owner,lat,lng,label,removed_at)
      SELECT ?,owner,lat,lng,label,? FROM locations WHERE owner=? AND ${activeCount}=0`,
      crypto.randomUUID(),new Date().toISOString(),owner),
    stmt(db,`DELETE FROM locations WHERE owner=? AND ${activeCount}=0`,owner),
  ]);
  changed(removed,'Withdraw your active requests before removing the saved location.',409);
  return c.json({ok:true});
});
async function requestLocation(db: D1Database, owner: string) {
  const point=await stmt(db,'SELECT lat,lng FROM locations WHERE owner=? AND use_for_requests=1',owner).first<Coordinate>();
  if (point && !isInServiceArea(point)) problem(409,pinOutsideServiceArea);
  return point;
}

resident.post('/proposals',async c=>{
  const input=await body(c,proposalInput);
  const owner=c.get('user').id;
  const db=c.env.DB;
  const previous=await existingSubmission(db,owner,input.submissionKey);
  if(previous) return c.json(previous);
  const point=await requestLocation(db,owner);
  if(!point) problem(409,'Choose a saved location to use for new requests.');
  const {id,created}=await submitProposal(db,owner,input,point);
  return c.json({id},created?201:200);
});

resident.post('/requests', async c => {
  const input = await body(c,requestInput);
  const owner = c.get('user').id;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const point=await requestLocation(c.env.DB,owner);
  if (!point) problem(409,'Choose a saved location to use for new requests.');
  const result = await stmt(c.env.DB,`INSERT INTO demand
    (id,owner,category,lat,lng,status,note,suggestion,suggested_lat,suggested_lng,created_at,confirmed_at)
    SELECT ?,owner,?,lat,lng,'recorded',?,?,?,?,?,? FROM locations
    WHERE owner=? AND use_for_requests=1 AND lat=? AND lng=? AND ${activeType}`,
    id,input.category,input.note,input.suggestion,input.point?.lat ?? null,input.point?.lng ?? null,now,now,owner,point.lat,point.lng,input.category).run();
  if(!result.meta.changes && !await activeEquipmentType(c.env.DB,input.category)) problem(409,typeUnavailable);
  changed(result,'Choose a saved location to use for new requests.',409);
  return c.json({id},201);
});
async function changedRequest(db:D1Database,result:D1Result,id:string,owner:string,status:string,nextType?:string) {
  if(result.meta.changes) return;
  const oldType=await stmt(db,'SELECT category FROM demand WHERE id=? AND owner=? AND status=?',id,owner,status).first<string>('category');
  if(oldType && (!await activeEquipmentType(db,oldType) || (nextType && !await activeEquipmentType(db,nextType)))) problem(409,typeUnavailable);
  changed(result);
}
const currentTypeActive='EXISTS (SELECT 1 FROM equipment_types WHERE id=demand.category AND active=1)';

resident.put('/requests/:id', async c => {
  const input = await body(c,requestInput);
  const {id}=c.req.param();
  const owner=c.get('user').id;
  const result=await stmt(c.env.DB,`UPDATE demand SET category=?,note=?,suggestion=?,suggested_lat=?,suggested_lng=?,
    confirmed_at=? WHERE id=? AND owner=? AND status='recorded' AND ${currentTypeActive} AND ${activeType}`,
    input.category,input.note,input.suggestion,input.point?.lat??null,input.point?.lng??null,
    new Date().toISOString(),id,owner,input.category).run();
  await changedRequest(c.env.DB,result,id,owner,'recorded',input.category);
  return c.json({ok:true});
});
resident.post('/requests/:id/:action', async c => {
  const owner = c.get('user').id;
  const id = c.req.param('id');
  const now = new Date().toISOString();
  const action = c.req.param('action');
  const db = c.env.DB;
  if (action==='restore') {
    const point=await requestLocation(db,owner);
    if (!point) problem(404,'Save a location before restoring this request.');
    const result=await stmt(db,`UPDATE demand SET status='recorded',lat=locations.lat,lng=locations.lng,confirmed_at=?
      FROM locations WHERE demand.id=? AND demand.owner=? AND locations.owner=demand.owner AND locations.use_for_requests=1
      AND locations.lat=? AND locations.lng=? AND demand.status='withdrawn' AND ${currentTypeActive}`,now,id,owner,point.lat,point.lng).run();
    await changedRequest(db,result,id,owner,'withdrawn');
    return c.json({ok:true});
  }
  const queries = {
    reconfirm: stmt(db,`UPDATE demand SET confirmed_at=? WHERE id=? AND owner=? AND status='recorded' AND ${currentTypeActive}`,now,id,owner),
    withdraw: stmt(db,"UPDATE demand SET status='withdrawn' WHERE id=? AND owner=? AND status='recorded'",id,owner),
  };
  if (!Object.hasOwn(queries,action)) return c.json({error:'Action not found.'},404);
  await changedRequest(db,await queries[action as keyof typeof queries].run(),id,owner,'recorded');
  return c.json({ok:true});
});
