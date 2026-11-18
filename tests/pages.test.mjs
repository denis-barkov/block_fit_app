import {afterEach,expect,it,vi} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import edge from '../src/pages/_worker.js';
import {createAuth} from '../src/server/auth';
import app from '../src/server/index';
import {packagePages,verifiedPages} from '../scripts/pages.mjs';
import {writeConfig} from '../scripts/environment.mjs';
import {packageWorker} from '../scripts/local.mjs';
import {database} from './database';

const origin='https://blockfit-demo.pages.dev';
const untrusted='https://private-worker.person-name.workers.dev';
const secret='synthetic auth secret for the pages tests only';
let runtime;
let proxy;
afterEach(async()=>{
  await Promise.all([runtime?.dispose(),proxy?.dispose()]);
  runtime=undefined;
  proxy=undefined;
});

it('uses a real Workerd HTTP service binding and sends only canonical public headers',async()=>{
  runtime=new Miniflare(convertV4MiniflareOptions({workers:[
    {name:'edge',compatibilityDate:'2026-11-18',modules:true,script:readFileSync('src/pages/_worker.js','utf8'),
      bindings:{APP_ORIGIN:origin},serviceBindings:{BACKEND:'backend'}},
    {name:'backend',compatibilityDate:'2026-11-18',modules:true,script:`
      export default {fetch(request) {
        const url=new URL(request.url);
        if(url.pathname==='/unsafe') return new Response('internal response',{status:302,headers:{Location:${JSON.stringify(untrusted)}}});
        return new Response(JSON.stringify({url:request.url, forwarded:request.headers.get('Forwarded'),
          original:request.headers.get('X-Original-Url'), redirect:request.redirect}),{
          headers:[['Content-Type','application/json'],['Server-Timing',${JSON.stringify(untrusted)}],['X-Backend',${JSON.stringify(untrusted)}],
            ['Set-Cookie','one=sample; Secure; HttpOnly; Domain=private-worker.person-name.workers.dev; Path=/'],
            ['Set-Cookie','two=sample; Secure; Path=/']],
        });
      }}`},
  ]}));
  const response=await runtime.dispatchFetch(origin+'/paths?sample=1',{headers:{
    Forwarded:'host=evil.invalid','X-Original-Url':untrusted,
  }});
  expect(await response.json()).toMatchObject({url:origin+'/paths?sample=1',forwarded:null,original:null});
  expect(response.headers.get('Server-Timing')).toBeNull();
  expect(response.headers.get('X-Backend')).toBeNull();
  expect(response.headers.getSetCookie()).toEqual(['one=sample; Secure; HttpOnly; Path=/','two=sample; Secure; Path=/']);
  const rejected=await runtime.dispatchFetch(origin+'/unsafe');
  expect(rejected.status).toBe(502);
  expect(rejected.headers.get('Location')).toBeNull();
  expect(await rejected.text()).not.toContain(untrusted);
  expect((await runtime.dispatchFetch('https://preview.blockfit-demo.pages.dev/')).status).toBe(404);
});

it('keeps real Better Auth cookies host-only, forwards session cookies, and rejects the backend hostname',async()=>{
  proxy=await database();
  const env={DB:proxy.env.DB,APP_ORIGIN:origin,AUTH_SECRET:secret,DEPLOYMENT:'prod',
    ASSETS:{fetch:async()=>new Response('public HTML')}};
  const auth=createAuth(env);
  const login='pages-staff@blockfit.example',password='A synthetic long test passphrase';
  await auth.api.createUser({body:{name:'Pages staff',email:login,password,role:'staff'}});
  const backend=vi.fn(request=>app.request(request,{},env));
  const front=(path,init)=>edge.fetch(new Request(origin+path,init),{APP_ORIGIN:origin,BACKEND:{fetch:backend}});
  const redirect=await front('/staff');
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get('Location')).toBe(origin+'/staff/login?returnTo=%2Fstaff');
  const signIn=await front('/api/auth/sign-in/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({email:login,password})});
  expect(signIn.status).toBe(200);
  const cookies=signIn.headers.getSetCookie();
  expect(cookies.some(line=>/Secure/i.test(line)&&/HttpOnly/i.test(line))).toBe(true);
  expect(cookies.every(line=>!/Domain=/i.test(line)&&!line.includes('workers.dev'))).toBe(true);
  const session=await front('/api/me',{headers:{Cookie:cookies.map(line=>line.split(';',1)[0]).join('; ')}});
  expect(await session.json()).toMatchObject({user:{role:'staff'}});
  expect((await app.request(untrusted+'/api/health',{},env)).status).toBe(404);
  const alias=await edge.fetch(new Request('https://preview.blockfit-demo.pages.dev/api/me'),{APP_ORIGIN:origin,BACKEND:{fetch:backend}});
  expect(alias.status).toBe(404);
  expect(backend).toHaveBeenCalledTimes(3);
});

it('derives the canonical URL from the owned Pages project and packages a private Worker',()=>{
  const project={id:'fake-project-uuid',name:'blockfit-demo',subdomain:'blockfit-demo-abc.pages.dev',production_branch:'main'};
  const manifest={pagesId:project.id,pagesName:project.name};
  const env={DEPLOYMENT:'prod',resourceName:'blockfit-nyc-prod',PAGES_PROJECT_NAME:project.name,
    CLOUDFLARE_ACCOUNT_ID:'00112233445566778899aabbccddeeff',AI_ENABLED:'false'};
  const target=verifiedPages(env,manifest,project);
  expect(target.APP_ORIGIN).toBe('https://blockfit-demo-abc.pages.dev');
  expect(()=>verifiedPages({...env,APP_ORIGIN:origin},manifest,project)).toThrow('canonical');
  expect(()=>verifiedPages(env,{...manifest,pagesId:'another'},project)).toThrow('manifest');
  const directory=mkdtempSync('.blockfit/pages-test-');
  try {
    const worker=writeConfig(target,{databaseId:'00112233-0000-4000-8000-aabbccddeeff',directory});
    const pages=packagePages(target,directory);
    const config=JSON.parse(readFileSync(worker,'utf8'));
    expect(config).toMatchObject({workers_dev:false,preview_urls:false,vars:{APP_ORIGIN:target.APP_ORIGIN}});
    expect(config.routes).toBeUndefined();
    const workerOutput=join(directory,'worker');
    vi.stubEnv('NODE_ENV','production');
    try {packageWorker(target,worker,workerOutput);}
    finally {vi.unstubAllEnvs();}
    const prompt=readFileSync('prompts/investment-comparison/explain-investment-options.txt','utf8');
    const packagedPrompt=readdirSync(workerOutput).find(name=>name.endsWith('-explain-investment-options.txt'));
    expect(packagedPrompt).toBeDefined();
    expect(readFileSync(join(workerOutput,packagedPrompt),'utf8')).toBe(prompt);
    expect(readFileSync(join(workerOutput,'index.js'),'utf8')).toContain(packagedPrompt);
    for(const folder of ['dist',pages.output]) {
      for(const file of readdirSync(folder,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())) {
        expect(readFileSync(join(file.parentPath,file.name),'utf8')).not.toContain(prompt.split('\n')[0]);
      }
    }
    expect(JSON.parse(readFileSync(pages.path,'utf8'))).toMatchObject({
      services:[{binding:'BACKEND',service:env.resourceName}],vars:{APP_ORIGIN:target.APP_ORIGIN},
    });
    expect(JSON.parse(readFileSync(join(pages.output,'_routes.json'),'utf8')).include).toEqual(['/*']);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
