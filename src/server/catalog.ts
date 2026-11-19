import { Hono } from 'hono';
import { z } from 'zod';
import { catalogLimits } from '../../config/settings';
import { category, proposalInput, typeDecision, typeFields, typeName, typeNameKey, typeUpdate,
  type ResidentProposal, type StaffEquipmentType, type TypeProposal } from '../contracts';
import { rows, stmt } from './database';
import { body, problem, type App } from './web';

export const typeUnavailable='This equipment type is currently unavailable. Choose an active type.';
export const activeType='EXISTS (SELECT 1 FROM equipment_types WHERE id=? AND active=1)';
const typeColumns='id,name,description,active';
const booleanType=(row:Omit<StaffEquipmentType,'active'> & {active:number})=>({...row,active:row.active===1});
const now=()=>new Date().toISOString();
const nameConflict='That name already exists. Use the existing type, or reactivate it in Equipment types if it is inactive.';
const normalizedConflict=(error:unknown)=>/UNIQUE constraint failed: equipment_types\.name_key/.test(String(error));
const privateIntent='lat=NULL,lng=NULL,note=NULL,suggestion=NULL,suggested_lat=NULL,suggested_lng=NULL';
const proposalColumns='p.id,p.name,p.description,p.submitted_at AS submittedAt,p.status';

export const publicTypes=async (db:D1Database)=>(
  await rows<{id:string;name:string;description:string}>(db,'SELECT id,name,description FROM equipment_types WHERE active=1 ORDER BY name_key,id')
).map(row=>({...row,active:true}));
export const activeEquipmentType=(db:D1Database,id:string)=>stmt(db,
  'SELECT id,name FROM equipment_types WHERE id=? AND active=1',id).first<{id:string;name:string}>();
const byName=(db:D1Database,key:string)=>stmt(db,'SELECT active FROM equipment_types WHERE name_key=?',key).first<number>('active');
const nameAvailability=(active:number|null)=>active===null?'missing':active===1?'active':'inactive';
const validID=(id:string)=>{
  if (!category.safeParse(id).success) problem(400,'Invalid record ID.');
  return id;
};
const page=(value:string|undefined)=>z.coerce.number().int().min(0).max(1_000_000).safeParse(value??0);
function paged<T>(result:T[],offset:number) {
  return {items:result.slice(0,catalogLimits.page),next:result.length>catalogLimits.page?offset+catalogLimits.page:null};
}

export const staffCatalog=new Hono<App>();
staffCatalog.get('/types',async c=>{
  const offset=page(c.req.query('offset'));
  const query=c.req.query('q')??'';
  const status=c.req.query('status')??'all';
  if(!offset.success || query.length>catalogLimits.nameMax || !['all','active','inactive'].includes(status)) problem(400,'Invalid catalog filter.');
  const active=status==='all'?null:Number(status==='active');
  const items=await rows<Parameters<typeof booleanType>[0]>(c.env.DB,
    `SELECT ${typeColumns},version FROM equipment_types WHERE instr(name_key,?)>0
    AND (? IS NULL OR active=?) ORDER BY name_key,id LIMIT ? OFFSET ?`,typeNameKey(query),active,active,catalogLimits.page+1,offset.data);
  // instr returns zero for nonmatches and one for the empty search.
  return c.json(paged(items.map(booleanType),offset.data));
});
staffCatalog.post('/types',async c=>{
  const {name,description}=await body(c,typeFields);
  const id=crypto.randomUUID();
  const date=now();
  try {
    await stmt(c.env.DB,'INSERT INTO equipment_types(id,name,name_key,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      id,name,typeNameKey(name),description,date,date).run();
  } catch(error) {
    if(normalizedConflict(error)) problem(409,nameConflict);
    throw error;
  }
  return c.json({id},201);
});
staffCatalog.put('/types/:id',async c=>{
  const {name,description,active,version,labelCorrection}=await body(c,typeUpdate);
  const db=c.env.DB;
  const id=validID(c.req.param('id'));
  if(!labelCorrection) {
    const existing=await stmt(db,'SELECT name,version FROM equipment_types WHERE id=?',id).first<{name:string;version:number}>();
    if(existing?.version===version&&existing.name!==name) problem(400,'Confirm that the new label describes the same equipment type.');
  }
  try {
    const result=await stmt(db,`UPDATE equipment_types SET name=?,name_key=?,description=?,active=?,updated_at=?,version=version+1
      WHERE id=? AND version=? AND (name=? OR ?=1)`,name,typeNameKey(name),description,Number(active),now(),id,version,name,Number(!!labelCorrection)).run();
    if(!result.meta.changes) problem(409,'This type changed. Refresh the catalog and try again.');
  } catch(error) {
    if(normalizedConflict(error)) problem(409,nameConflict);
    throw error;
  }
  return c.json({ok:true});
});
staffCatalog.get('/proposals',async c=>{
  const offset=page(c.req.query('offset'));
  const status=c.req.query('status')??'pending';
  if(!offset.success || !['pending','approved','rejected','withdrawn'].includes(status)) problem(400,'Invalid proposal filter.');
  const items=await rows<TypeProposal & {categoryName:string|null;reason:string|null;decidedAt:string|null}>(c.env.DB,
    `SELECT ${proposalColumns},t.name AS categoryName,p.reason,p.decided_at AS decidedAt FROM type_proposals p
    LEFT JOIN equipment_types t ON t.id=p.category WHERE p.status=?
    ORDER BY p.submitted_at DESC,p.id LIMIT ? OFFSET ?`,status,catalogLimits.page+1,offset.data);
  return c.json(paged(items,offset.data));
});
staffCatalog.post('/proposals/:id/decision',async c=>{
  const input=await body(c,typeDecision);
  const db=c.env.DB;
  const id=validID(c.req.param('id'));
  const reviewer=c.get('user').id;
  const decidedAt=now();
  const pending="id=? AND status='pending'";
  if(input.action==='reject') {
    const updated=await stmt(db,`UPDATE type_proposals SET status='rejected',reviewer=?,decided_at=?,reason=?,${privateIntent}
      WHERE ${pending}`,reviewer,decidedAt,input.reason,id).run();
    if(!updated.meta.changes) problem(409,'This proposal was already reviewed or withdrawn. Refresh the queue.');
    return c.json({ok:true});
  }
  const finalType=input.action==='create'?crypto.randomUUID():input.category;
  const requestId=crypto.randomUUID();
  const create=input.action==='create'?[stmt(db,`INSERT INTO equipment_types(id,name,name_key,created_at,updated_at)
    SELECT ?,?,?,?,? FROM type_proposals WHERE ${pending}`,finalType,input.name,typeNameKey(input.name),decidedAt,decidedAt,id)]:[];
  // Perform all writes in one D1 transaction. The partial unique index also protects against a normal request submitted concurrently.
  try {
    const result=await db.batch([
      ...create,
      stmt(db,`INSERT INTO demand(id,owner,category,lat,lng,status,note,suggestion,suggested_lat,suggested_lng,created_at,confirmed_at)
        SELECT ?,owner,?,lat,lng,'recorded',note,suggestion,suggested_lat,suggested_lng,submitted_at,submitted_at
        FROM type_proposals WHERE ${pending} AND ${activeType}
        ON CONFLICT(owner,category) WHERE status='recorded' DO NOTHING`,requestId,finalType,id,finalType),
      stmt(db,`UPDATE type_proposals SET status='approved',reviewer=?,decided_at=?,category=?,
        request_id=(SELECT id FROM demand d WHERE d.owner=type_proposals.owner AND d.category=? AND d.status='recorded'),
        reused_request=NOT EXISTS(SELECT 1 FROM demand WHERE id=?),${privateIntent}
        WHERE ${pending} AND ${activeType}`,reviewer,decidedAt,finalType,finalType,requestId,id,finalType),
    ]);
    if(!result.at(-1)?.meta.changes) {
      const current=await stmt(db,'SELECT status FROM type_proposals WHERE id=?',id).first('status');
      if(current==='pending') problem(409,typeUnavailable);
      problem(409,'This proposal was already reviewed or withdrawn. Refresh the queue.');
    }
  } catch(error) {
    if(normalizedConflict(error)) problem(409,nameConflict);
    throw error;
  }
  return c.json({ok:true});
});

export const residentCatalog=new Hono<App>();
export async function residentProposals(db:D1Database,owner:string,offset=0) {
  type Row=Omit<ResidentProposal,'reusedRequest'>&{reusedRequest:number};
  return (await rows<Row>(db,`SELECT ${proposalColumns},p.decided_at AS decidedAt,p.reason,p.request_id AS requestId,
    p.reused_request AS reusedRequest,t.name AS categoryName FROM type_proposals p LEFT JOIN equipment_types t ON t.id=p.category
    WHERE p.owner=? ORDER BY (p.status='pending') DESC,p.submitted_at DESC,p.id LIMIT ? OFFSET ?`,owner,catalogLimits.page+1,offset))
    .map(row=>({...row,reusedRequest:row.reusedRequest===1}));
}
residentCatalog.get('/proposals',async c=>{
  const offset=page(c.req.query('offset'));
  if(!offset.success) problem(400,'Invalid proposal page.');
  return c.json(paged(await residentProposals(c.env.DB,c.get('user').id,offset.data),offset.data));
});
residentCatalog.post('/proposal-name',async c=>{
  const {name}=await body(c,z.object({name:typeName}).strict());
  return c.json({availability:nameAvailability(await byName(c.env.DB,typeNameKey(name)))});
});

export async function existingSubmission(db:D1Database,owner:string,key:string) {
  return stmt(db,'SELECT id FROM type_proposals WHERE owner=? AND submission_key=?',owner,key).first<{id:string}>();
}
export async function submitProposal(db:D1Database,owner:string,input:z.infer<typeof proposalInput>,point:{lat:number;lng:number}) {
  const id=crypto.randomUUID();
  const nameKey=typeNameKey(input.name);
  const date=now();
  const start=date.slice(0,10);
  const result=await stmt(db,`INSERT INTO type_proposals
    (id,owner,name,name_key,description,submitted_at,submission_key,lat,lng,note,suggestion,suggested_lat,suggested_lng)
    SELECT ?,owner,?,?,?,?,?,lat,lng,?,?,?,? FROM locations
    WHERE owner=? AND use_for_requests=1 AND lat=? AND lng=?
      AND NOT EXISTS(SELECT 1 FROM equipment_types WHERE name_key=?)
      AND (SELECT count(*) FROM type_proposals WHERE owner=? AND status='pending')<?
      AND (SELECT count(*) FROM type_proposals WHERE owner=? AND submitted_at>=?)<?
    ON CONFLICT DO NOTHING RETURNING id`,
    id,input.name,nameKey,input.description,date,input.submissionKey,input.note,input.suggestion,input.point?.lat??null,input.point?.lng??null,
    owner,point.lat,point.lng,nameKey,owner,catalogLimits.pending,owner,start,catalogLimits.daily).first<{id:string}>();
  if(result) return {id:result.id,created:true};
  const previous=await existingSubmission(db,owner,input.submissionKey);
  if(previous) return {...previous,created:false};
  const availability=await byName(db,nameKey);
  if(availability===0) problem(409,typeUnavailable);
  if(availability===1) problem(409,'This type is already in the catalog. Choose it for a regular request.');
  const [duplicate,daily,pending]=await db.batch<{count:number}>([
    stmt(db,"SELECT id FROM type_proposals WHERE owner=? AND name_key=? AND status='pending'",owner,nameKey),
    stmt(db,'SELECT count(*) AS count FROM type_proposals WHERE owner=? AND submitted_at>=?',owner,start),
    stmt(db,"SELECT count(*) AS count FROM type_proposals WHERE owner=? AND status='pending'",owner),
  ]);
  if(duplicate.results.length) problem(409,'You already have a pending suggestion with this name in Request history.');
  if(Number(daily.results[0]?.count)>=catalogLimits.daily) problem(429,'You have reached today’s type suggestion limit.');
  if(Number(pending.results[0]?.count)>=catalogLimits.pending) problem(429,'Review or withdraw a pending suggestion before submitting another.');
  problem(409,'Choose a saved location to use for new requests.');
}
residentCatalog.post('/proposals/:id/withdraw',async c=>{
  const result=await stmt(c.env.DB,`UPDATE type_proposals SET status='withdrawn',decided_at=?,${privateIntent}
    WHERE id=? AND owner=? AND status='pending'`,now(),validID(c.req.param('id')),c.get('user').id).run();
  if(!result.meta.changes) problem(404,'No pending suggestion was found.');
  return c.json({ok:true});
});
