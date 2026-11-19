import { Hono } from 'hono';
import { comparisonBriefFilename } from '../../config/app';
import { isInServiceArea, pinOutsideServiceArea } from '../../config/map-area';
import { z } from 'zod';
import { candidateInput, equipmentInput, parkInput, scenarioInput, type Coordinate, type Scenario } from '../contracts';
import { cachedExplanation, explain } from './ai';
import { getComparison, staffInventory, stmt, throttle } from './database';
import { makeBrief } from './planning';
import { body, changed, problem, type App } from './web';

export const staff = new Hono<App>();
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
  if (id) {
    changed(await stmt(db,`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')}
      WHERE id=? AND archived=0`,...values,id).run());
    return id;
  }
  const newId = crypto.randomUUID();
  await stmt(db,`INSERT INTO ${table}(id,${columns.join(',')}) VALUES (?,${values.map(() => '?').join(',')})`,
    newId,...values).run();
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
  const {parkId,costs,projectUrl,...candidate} = await body(c,candidateInput);
  if (parkId && !await stmt(db,'SELECT id FROM parks WHERE id=? AND archived=0',parkId).first()) problem(400,'Choose an active park.');
  return c.json({id:await save(db,'candidates',id,{...candidate,park_id:parkId,costs:JSON.stringify(costs),project_url:projectUrl})},id?200:201);
});
staff.delete('/inventory/:kind/:id', async c => {
  const table = kind.safeParse(c.req.param('kind'));
  if (!table.success) problem(404,'Inventory type not found.');
  changed(await stmt(c.env.DB,`UPDATE ${table.data} SET archived=1 WHERE id=? AND archived=0`,c.req.param('id')).run());
  return c.json({ok:true});
});

async function comparison(db: D1Database, input: Scenario, testWorkspace: boolean, revision?: number) {
  const result = await getComparison(db,input,testWorkspace);
  if (result === 'limit') problem(409,'The pilot dataset exceeds the comparison limit.');
  if (!result) problem(400,'Select active candidates of this category that are eligible for comparison.');
  if (revision !== undefined && result.revision !== revision) problem(409,'Data has changed. Refresh the comparison.');
  return result;
}
staff.post('/compare',async c => {
  const result = await comparison(c.env.DB,await body(c,scenarioInput),isTest(c));
  return c.json({ ...result, explanation:isTest(c)?undefined:await cachedExplanation(c.env,result) });
});
const reference = z.object({scenario:scenarioInput,revision:z.number().int().nonnegative(),calculatedAt:z.iso.datetime()}).strict();
staff.post('/export',async c => {
  const {scenario,revision,calculatedAt} = await body(c,reference);
  const result = await comparison(c.env.DB,scenario,isTest(c),revision);
  return c.body(makeBrief({...result,calculatedAt},isTest(c)?undefined:await cachedExplanation(c.env,result)),200,{
    'Content-Type':'text/markdown; charset=UTF-8','Content-Disposition':`attachment; filename="${comparisonBriefFilename}"`,
  });
});
staff.post('/explain',async c => {
  if(isTest(c)) problem(403,'AI explanations are unavailable in the automated-test workspace.');
  if (!await throttle(c.env.DB,`ai:${c.get('user').id}`,12)) problem(429,'Too many requests. Try again shortly.');
  const {scenario,revision} = await body(c,reference);
  const result = await comparison(c.env.DB,scenario,isTest(c),revision);
  return c.json(await explain(c.env,result,fetch,c.get('requestId')));
});
