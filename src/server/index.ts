import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { limits } from '../../config/settings';
import { category } from '../contracts';
import { loginLink,residentLogin,returnPath,staffHome,staffInventoryPage,staffLogin } from '../routes';
import { createAuth } from './auth';
import { inventory, stmt, throttle } from './database';
import { resident } from './resident';
import { staff } from './staff';
import { body, problem, type App } from './web';

const app = new Hono<App>({strict:false});
app.onError((error,c) => {
  if (error instanceof HTTPException) return c.json({error:error.message},error.status);
  if (/UNIQUE constraint failed: demand\.owner, demand\.category/.test(String(error))) {
    return c.json({error:'You already have an active request for that equipment.'},409);
  }
  console.error(JSON.stringify({level:'error',operation:'request_failed',requestId:c.get('requestId')}));
  return c.json({error:'Something went wrong. Try again.',requestId:c.get('requestId')},500);
});
app.use('*',async (c,next) => {
  c.set('requestId',crypto.randomUUID());
  c.header('X-Content-Type-Options','nosniff');
  c.header('Referrer-Policy','strict-origin-when-cross-origin');
  if (await stmt(c.env.DB,'SELECT suspended FROM operations WHERE id=1').first<number>('suspended')) {
    return c.text('BlockFit NYC is temporarily unavailable.',503,{'Cache-Control':'no-store'});
  }
  await next();
});
app.use('/api/*',async (c,next) => {
  c.header('Cache-Control','no-store');
  if (!['GET','HEAD'].includes(c.req.method) && c.req.header('Origin') !== c.env.APP_ORIGIN) {
    problem(403,'This action requires the BlockFit website origin.');
  }
  await next();
});
app.use('/api/*',bodyLimit({maxSize:limits.bodyBytes,onError:() => problem(413,'This request is too large.')}));
app.get('/api/config',c => c.json({contact:c.env.CONTACT_EMAIL || null}));
app.get('/api/health',c => c.json({ok:true}));
app.get('/api/inventory',etag(),async c => {
  const filter = c.req.query('category');
  const search = c.req.query('q')?.trim() ?? '';
  if (filter && !category.safeParse(filter).success) problem(400,'Choose a valid equipment type.');
  if (search.length > limits.shortText) problem(400,'Search text is too long.');
  const result = await inventory(c.env.DB,filter || null,search);
  c.header('Cache-Control','public, max-age=0, must-revalidate');
  return c.json(result);
});
app.get('/api/me',async c => {
  const session = await createAuth(c.env).api.getSession({headers:c.req.raw.headers});
  const user = session?.user;
  return c.json({user:user ? {id:user.id,name:user.name,email:user.email,role:user.role,purpose:user.purpose??null} : null});
});

const login = z.object({email:z.email().max(254),password:z.string().min(1).max(limits.maxPassword)}).strict();
const register = login.extend({name:z.string().trim().min(1).max(limits.shortText),
  password:z.string().min(limits.minPassword).max(limits.maxPassword), confirmation:z.string().max(limits.maxPassword)})
  .refine(input => input.password === input.confirmation,'Passwords must match.');
const change = z.object({currentPassword:z.string().min(1).max(limits.maxPassword),
  newPassword:z.string().min(limits.minPassword).max(limits.maxPassword),
  confirmation:z.string().max(limits.maxPassword)}).strict()
  .refine(input => input.newPassword === input.confirmation,'Passwords must match.');
app.post('/api/auth/:group/:action?',async c => {
  const path = c.req.param('action') ? `${c.req.param('group')}/${c.req.param('action')}` : c.req.param('group');
  const auth = createAuth(c.env);
  const delegate = (input: object) => {
    const headers=new Headers(c.req.raw.headers);
    headers.delete('Content-Length');
    headers.set('Content-Type','application/json');
    return auth.handler(new Request(c.req.url,{method:'POST',headers,body:JSON.stringify(input)}));
  };
  if (path === 'sign-out') return delegate({});
  if (path === 'change-password') {
    const {currentPassword,newPassword} = await body(c,change);
    return delegate({currentPassword,newPassword,revokeOtherSessions:true});
  }
  if (path !== 'sign-in/email' && path !== 'sign-up/email') problem(404,'Authentication action not available.');
  const incoming = path === 'sign-up/email' ? await body(c,register) : await body(c,login);
  if (await auth.api.getSession({headers:c.req.raw.headers})) problem(409,'Sign out before switching accounts.');
  const email = incoming.email.toLowerCase();
  const clientIP = c.env.DEPLOYMENT === 'prod' ? c.req.header('CF-Connecting-IP') || 'unknown' : 'loopback';
  const input = new TextEncoder().encode(`${c.env.AUTH_SECRET}\0${path}\0${email}`);
  const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256',input))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  if (!await throttle(c.env.DB,`ip:${path}:${clientIP}`,40) ||
      !await throttle(c.env.DB,`login:${key}`,6)) problem(429,'Too many attempts. Try again in a few minutes.');
  const normalized = {email,password:incoming.password};
  return delegate('name' in incoming ? {...normalized,name:incoming.name} : normalized);
});
app.use('/api/resident/*',async (c,next) => {
  const session = await createAuth(c.env).api.getSession({headers:c.req.raw.headers});
  if (!session) problem(401,'Sign in to manage your requests.');
  if (session.user.role !== 'resident') problem(403,'Resident access is required.');
  c.set('user',session.user);
  await next();
});
app.route('/api/resident',resident);
app.use('/api/staff/*',async (c,next) => {
  const session = await createAuth(c.env).api.getSession({headers:c.req.raw.headers});
  if (!session) problem(401,'Sign in to open the City workspace.');
  if (session.user.role !== 'staff') problem(403,'Staff access is required.');
  c.set('user',session.user);
  await next();
});
app.route('/api/staff',staff);
app.all('/api/*',c => c.json({error:'Route not found.'},404));
app.get('*',async c => {
  const path=c.req.path.replace(/\/$/,'')||'/';
  if (path==='/city') return c.redirect(staffHome,302);
  const isStaffPage=path===staffHome||path.startsWith(staffHome+'/');
  if (!isStaffPage && !['/requests',residentLogin].includes(path)) return c.env.ASSETS.fetch(c.req.raw);

  const session=await createAuth(c.env).api.getSession({headers:c.req.raw.headers});
  const here=path+new URL(c.req.url).search;
  const next=c.req.query('returnTo')??null;
  c.header('Cache-Control','no-store');
  if (isStaffPage) {
    if (!session && path!==staffLogin) return c.redirect(loginLink('staff',here),302);
    if (session?.user.role==='staff') {
      if (path===staffLogin) return c.redirect(session.user.purpose==='automated-test'?staffHome:returnPath('staff',next),302);
      if (path===staffInventoryPage && session.user.purpose==='automated-test') return c.redirect(staffHome,302);
      if (![staffHome,staffInventoryPage].includes(path)) return c.redirect(staffHome,302);
    }
  } else {
    if (!session && path==='/requests') return c.redirect(loginLink('resident',here),302);
    if (path===residentLogin && session) {
      return c.redirect(session.user.role==='staff'?staffHome:returnPath('resident',next),302);
    }
  }
  const asset=await c.env.ASSETS.fetch(new Request(new URL('/',c.req.url),c.req.raw));
  const headers=new Headers(asset.headers);
  headers.set('Cache-Control','no-store');
  const mismatch=session && (isStaffPage?session.user.role!=='staff':session.user.role!=='resident');
  return new Response(asset.body,{status:mismatch?403:asset.status,headers});
});

export default app;
