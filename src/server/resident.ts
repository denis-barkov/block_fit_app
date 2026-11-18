import { Hono } from 'hono';
import { locationInput, requestInput, type SavedLocation } from '../contracts';
import { requests, stmt } from './database';
import { body, changed, type App } from './web';

export const resident = new Hono<App>();
resident.get('/', async c => {
  const owner = c.get('user').id;
  const [location, history] = await Promise.all([
    stmt(c.env.DB,'SELECT lat,lng,label FROM locations WHERE owner=?',owner).first<SavedLocation>(),
    requests(c.env.DB,owner),
  ]);
  return c.json({location, requests:history});
});
resident.put('/location', async c => {
  const { lat,lng,label } = await body(c,locationInput);
  await stmt(c.env.DB,`INSERT INTO locations (owner,lat,lng,label,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(owner) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,label=excluded.label,updated_at=excluded.updated_at`,
    c.get('user').id,lat,lng,label,new Date().toISOString()).run();
  return c.json({ok:true});
});
resident.post('/requests', async c => {
  const input = await body(c,requestInput);
  const owner = c.get('user').id;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const result = await stmt(c.env.DB,`INSERT INTO demand
    (id,owner,category,lat,lng,status,note,suggestion,suggested_lat,suggested_lng,created_at,confirmed_at)
    SELECT ?,owner,?,lat,lng,'recorded',?,?,?,?,?,? FROM locations WHERE owner=?`,
    id,input.category,input.note,input.suggestion,input.point?.lat ?? null,input.point?.lng ?? null,now,now,owner).run();
  changed(result,'Save a private location before recording a request.',409);
  return c.json({id},201);
});
resident.put('/requests/:id', async c => {
  const input = await body(c,requestInput);
  changed(await stmt(c.env.DB,`UPDATE demand SET category=?,note=?,suggestion=?,suggested_lat=?,suggested_lng=?,
    confirmed_at=? WHERE id=? AND owner=? AND status='recorded'`,
    input.category,input.note,input.suggestion,input.point?.lat??null,input.point?.lng??null,
    new Date().toISOString(),c.req.param('id'),c.get('user').id).run());
  return c.json({ok:true});
});
resident.post('/requests/:id/:action', async c => {
  const owner = c.get('user').id;
  const id = c.req.param('id');
  const now = new Date().toISOString();
  const action = c.req.param('action');
  const db = c.env.DB;
  const queries = {
    reconfirm: stmt(db,"UPDATE demand SET confirmed_at=? WHERE id=? AND owner=? AND status='recorded'",now,id,owner),
    withdraw: stmt(db,"UPDATE demand SET status='withdrawn' WHERE id=? AND owner=? AND status='recorded'",id,owner),
    restore: stmt(db,`UPDATE demand SET status='recorded',lat=locations.lat,lng=locations.lng,confirmed_at=?
      FROM locations WHERE demand.id=? AND demand.owner=? AND locations.owner=demand.owner AND demand.status='withdrawn'`,now,id,owner),
  };
  if (!Object.hasOwn(queries,action)) return c.json({error:'Action not found.'},404);
  changed(await queries[action as keyof typeof queries].run());
  return c.json({ok:true});
});
