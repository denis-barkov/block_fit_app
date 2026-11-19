import { Hono } from 'hono';
import { z } from 'zod';
import { goalLimits } from '../../config/goals';
import { goalDates, goalInput, goalRef, type Goal, type GoalRef } from '../goals';
import { rows, stmt } from './database';
import { body, problem, type App } from './web';

const columns=`g.id,g.name,g.description,g.earliest_start AS earliestStart,g.target_completion AS targetCompletion,
  g.version,g.created_at AS createdAt,g.updated_at AS updatedAt,g.allowed_types AS allowedTypes,
  (SELECT json_group_array(json_object('id',entry.value,'name',coalesce(t.name,'Unavailable equipment type'),
     'description',coalesce(t.description,''),'active',coalesce(t.active,0)))
   FROM json_each(g.allowed_types) entry LEFT JOIN equipment_types t ON t.id=entry.value) AS types`;
type Row=Omit<Goal,'allowedTypes'|'types'>&{allowedTypes:string;types:string};
function fromRow(row:Row):Goal {
  const types=JSON.parse(row.types) as (Omit<Goal['types'][number],'active'>&{active:number})[];
  return {...row,allowedTypes:JSON.parse(row.allowedTypes),types:types.map(type=>({...type,active:!!type.active}))};
}
export async function currentGoal(db:D1Database,ref:GoalRef) {
  const row=await stmt(db,`SELECT ${columns} FROM program_goals g WHERE g.id=? AND g.deleted_at IS NULL`,ref.id).first<Row>();
  if(!row||row.version!==ref.version)problem(409,'This goal was changed or deleted. Refresh goals before continuing.');
  return fromRow(row);
}

const fields=goalInput.refine(goalDates,'Earliest start must be on or before target completion.');
const editInput=goalInput.extend({version:goalRef.shape.version}).refine(goalDates,'Earliest start must be on or before target completion.').strict();
const goalId=goalRef.shape.id;
const stale='This goal was changed or deleted. Refresh goals and review your edits.';
const invalidTypes='Choose active equipment types. Existing unavailable types may be retained or removed.';
const unavailableTypes=`SELECT 1 FROM json_each(?) chosen
  LEFT JOIN equipment_types t ON t.id=chosen.value WHERE (t.id IS NULL OR t.active=0)`;

export const staffGoals=new Hono<App>();
staffGoals.get('/goals',async c=>c.json((await rows<Row>(c.env.DB,
  `SELECT ${columns} FROM program_goals g WHERE g.deleted_at IS NULL ORDER BY g.name COLLATE NOCASE,g.id LIMIT ?`,goalLimits.saved)).map(fromRow)));
staffGoals.post('/goals',async c=>{
  const input=await body(c,fields);
  const id=crypto.randomUUID(), date=new Date().toISOString(), allowed=JSON.stringify([...input.allowedTypes].sort());
  const result=await stmt(c.env.DB,`INSERT INTO program_goals
    (id,name,description,earliest_start,target_completion,allowed_types,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (${unavailableTypes})
    AND (SELECT count(*) FROM program_goals WHERE deleted_at IS NULL)<?`,
    id,input.name,input.description,input.earliestStart,input.targetCompletion,allowed,date,date,allowed,goalLimits.saved).run();
  if(!result.meta.changes) {
    if(await stmt(c.env.DB,unavailableTypes,allowed).first())problem(409,invalidTypes);
    problem(409,'The saved goal limit has been reached. Delete a goal to add another.');
  }
  return c.json({id,version:1},201);
});
staffGoals.put('/goals/:id',async c=>{
  const id=goalId.safeParse(c.req.param('id'));
  if(!id.success)problem(400,'Invalid goal ID.');
  const input=await body(c,editInput);
  const allowed=JSON.stringify([...input.allowedTypes].sort());
  const db=c.env.DB;
  const result=await stmt(db,`UPDATE program_goals AS g
    SET name=?,description=?,earliest_start=?,target_completion=?,allowed_types=?,updated_at=?,version=version+1
    WHERE g.id=? AND g.deleted_at IS NULL AND g.version=?
      AND NOT EXISTS (${unavailableTypes} AND chosen.value NOT IN (SELECT value FROM json_each(g.allowed_types)))`,
    input.name,input.description,input.earliestStart,input.targetCompletion,allowed,new Date().toISOString(),id.data,input.version,allowed).run();
  if(!result.meta.changes) {
    const previous=await currentGoal(db,{id:id.data,version:input.version});
    const added=input.allowedTypes.filter(type=>!previous.allowedTypes.includes(type));
    if(await stmt(db,unavailableTypes,JSON.stringify(added)).first())problem(409,invalidTypes);
    problem(409,stale);
  }
  return c.json({id:id.data,version:input.version+1});
});
staffGoals.delete('/goals/:id',async c=>{
  const id=goalId.safeParse(c.req.param('id'));
  if(!id.success)problem(400,'Invalid goal ID.');
  const {version}=await body(c,z.object({version:goalRef.shape.version}).strict());
  const date=new Date().toISOString();
  const result=await stmt(c.env.DB,`UPDATE program_goals SET deleted_at=?,updated_at=?,version=version+1
    WHERE id=? AND version=? AND deleted_at IS NULL`,date,date,id.data,version).run();
  if(!result.meta.changes)problem(409,stale);
  return c.json({ok:true});
});
