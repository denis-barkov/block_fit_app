import { Hono } from 'hono';
import { comparisonBriefFilename } from '../../config/app';
import { isInServiceArea, pinOutsideServiceArea } from '../../config/map-area';
import { z } from 'zod';
import { candidateInput, equipmentInput, parkInput, scenarioInput, type Coordinate, type Scenario } from '../contracts';
import { comparisonRef, goalComparisonRef, goalViewInput } from '../goals';
import { cachedExplanation, explain } from './ai';
import { hash } from './ai-gateway';
import { activeEquipmentType, activeType, staffCatalog, typeUnavailable } from './catalog';
import { getComparison, staffInventory, stmt, throttle } from './database';
import { makeBrief, type Comparison } from './planning';
import { staffGoals } from './program-goals';
import { evaluateGoal, goalBrief, goalExplanationContext, goalReview } from './goal-evaluation';
import type { Context } from 'hono';
import { body, changed, problem, type App } from './web';

export const staff = new Hono<App>();
staff.route('/',staffCatalog);
staff.route('/',staffGoals);
const isTest=(c:import('hono').Context<App>)=>c.get('user').purpose==='automated-test';
staff.use('/inventory/*',async (c,next)=>{
  if (isTest(c)) problem(403,'Automated-test staff use the isolated comparison workspace.');
  await next();
});
staff.get('/inventory', async c => c.json(await staffInventory(c.env.DB)));
const kind = z.enum(['parks','equipment','candidates']);
async function save(db: D1Database, table: string, id: string|null, data: Coordinate & Record<string,string|number|null>) {
  if (!isInServiceArea(data)) problem(400,pinOutsideServiceArea);
  const columns = Object.keys(data);
  const values = Object.values(data);
  const category=typeof data.category==='string'?data.category:null;
  if (id) {
    const result=await stmt(db,`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')}
      WHERE id=? AND archived=0 ${category?'AND (category=? OR '+activeType+')':''}`,
      ...values,id,...(category?[category,category]:[])).run();
    if(!result.meta.changes && category && !await activeEquipmentType(db,category)) problem(409,typeUnavailable);
    changed(result);
    return id;
  }
  const newId = crypto.randomUUID();
  const result=await stmt(db,`INSERT INTO ${table}(id,${columns.join(',')})
    SELECT ?,${values.map(() => '?').join(',')} ${category?'WHERE '+activeType:''}`,
    newId,...values,...(category?[category]:[])).run();
  changed(result,typeUnavailable,409);
  return newId;
}
staff.on(['POST','PUT'],'/inventory/:kind/:id?',async c => {
  const table = kind.safeParse(c.req.param('kind'));
  if (!table.success) problem(404,'Inventory type not found.');
  const id = c.req.param('id') ?? null;
  if ((c.req.method === 'PUT') !== !!id) problem(400,'Invalid inventory action.');
  const db = c.env.DB;
  if (table.data === 'parks') {
    const {externalId,cityMaintained,...park} = await body(c,parkInput);
    return c.json({id:await save(db,'parks',id,{...park,external_id:externalId,city_maintained:Number(cityMaintained)})},id?200:201);
  }
  if (table.data === 'equipment') {
    const {parkId,verifiedOn,visible,...equipment} = await body(c,equipmentInput);
    if (parkId && !await stmt(db,'SELECT id FROM parks WHERE id=? AND archived=0',parkId).first()) problem(400,'Choose an active park.');
    return c.json({id:await save(db,'equipment',id,{...equipment,park_id:parkId,verified_on:verifiedOn,visible:Number(visible)})},id?200:201);
  }
  const {parkId,costs,projectUrl,estimatedStart,estimatedReady,...candidate} = await body(c,candidateInput);
  if (parkId && !await stmt(db,'SELECT id FROM parks WHERE id=? AND archived=0',parkId).first()) problem(400,'Choose an active park.');
  return c.json({id:await save(db,'candidates',id,{...candidate,park_id:parkId,costs:JSON.stringify(costs),project_url:projectUrl,estimated_start:estimatedStart,estimated_ready:estimatedReady})},id?200:201);
});
staff.delete('/inventory/:kind/:id', async c => {
  const table = kind.safeParse(c.req.param('kind'));
  if (!table.success) problem(404,'Inventory type not found.');
  changed(await stmt(c.env.DB,`UPDATE ${table.data} SET archived=1 WHERE id=? AND archived=0`,c.req.param('id')).run());
  return c.json({ok:true});
});

async function comparison(db: D1Database, input: Scenario, testWorkspace: boolean, revision?: number) {
  const result = await getComparison(db,input,testWorkspace);
  if (result === 'inactive') problem(409,typeUnavailable);
  if (result === 'limit') problem(409,'The pilot dataset exceeds the comparison limit.');
  if (!result) problem(400,'Select active candidates of this category that are eligible for comparison.');
  if (revision !== undefined && result.revision !== revision) problem(409,'Data has changed. Refresh the comparison.');
  return result;
}
staff.post('/compare',async c => {
  const result = await comparison(c.env.DB,await body(c,scenarioInput),isTest(c));
  return c.json({ ...result, explanation:isTest(c)?undefined:await cachedExplanation(c.env,result) });
});
const reference=comparisonRef.extend({goal:goalViewInput.optional()}).strict();
const staffScope=(c:Context<App>)=>hash(JSON.stringify(['staff-generation',c.env.AUTH_SECRET,c.get('user').id]));
type ViewInput=z.infer<typeof goalViewInput>;
async function visibleGoal(c:Context<App>,result:Comparison,view:ViewInput) {
  const review=await goalReview(c.env,result,view);
  if(view.evaluationKey && review.evaluationKey!==view.evaluationKey)
    problem(409,'The goal evaluation changed or expired. Refresh its results.');
  return view.evaluationKey?review:{...review,evaluation:null,evaluationKey:null};
}
staff.post('/goals/preview',async c=>{
  const {scenario,revision,goal}=await body(c,goalComparisonRef);
  return c.json(await goalReview(c.env,await comparison(c.env.DB,scenario,isTest(c),revision),goal));
});
staff.post('/goals/evaluate',async c=>{
  const {scenario,revision,goal}=await body(c,goalComparisonRef);
  const result=await comparison(c.env.DB,scenario,isTest(c),revision);
  return c.json(await evaluateGoal(c.env,result,goal,await staffScope(c),c.get('requestId')));
});
staff.post('/export',async c => {
  const {scenario,revision,calculatedAt,goal} = await body(c,reference);
  const result = await comparison(c.env.DB,scenario,isTest(c),revision);
  const review=goal?await visibleGoal(c,result,goal):undefined;
  const context=goal&&review?goalExplanationContext(result,review,goal.filter,goal.order):undefined;
  const section=goal&&review?goalBrief(result,review,goal.filter,goal.order):undefined;
  return c.body(makeBrief({...result,calculatedAt},isTest(c)&&!goal?undefined:await cachedExplanation(c.env,result,context),section),200,{
    'Content-Type':'text/markdown; charset=UTF-8','Content-Disposition':`attachment; filename="${comparisonBriefFilename}"`,
  });
});
staff.post('/explain',async c => {
  if(isTest(c)) problem(403,'AI explanations are unavailable in the automated-test workspace.');
  const {scenario,revision,goal} = await body(c,reference);
  if (!await throttle(c.env.DB,`ai:${c.get('user').id}`,12)) problem(429,'Too many requests. Try again shortly.');
  const result = await comparison(c.env.DB,scenario,isTest(c),revision);
  const review=goal?await visibleGoal(c,result,goal):undefined;
  return c.json(await explain(c.env,result,fetch,c.get('requestId'),{staffScope:await staffScope(c),testWorkspace:isTest(c),goal},
    goal&&review?goalExplanationContext(result,review,goal.filter,goal.order):undefined));
});
