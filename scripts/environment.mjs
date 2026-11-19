import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {parseEnv} from 'node:util';
import {dirname,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {z} from 'zod';

export const state=resolve('.blockfit');
const sharedModelSettings=['OPENAI_MODEL','OPENAI_REASONING_EFFORT'];
const readEnv = path => existsSync(path)?parseEnv(readFileSync(path,'utf8')):{};
const name=z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const letterToken=z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/);
const optionalText=z.string().optional().default('');
const schema=z.object({
  PROJECT_NAME:name,MANAGED_BY:z.literal('script'),SERVICE_PART:letterToken.or(z.literal('')).optional(),FUNDING:letterToken.or(z.literal('')).optional(),
  DEPLOYMENT:z.enum(['local','prod']),APP_ORIGIN:optionalText,AUTH_SECRET:z.string().min(32),
  CONTACT_EMAIL:z.email().or(z.literal('')).optional(),
  CLOUDFLARE_ACCOUNT_ID:optionalText,CLOUDFLARE_API_TOKEN:optionalText,CLOUDFLARE_TAG_API_TOKEN:optionalText,
  PAGES_PROJECT_NAME:z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/).or(z.literal('')).optional().default(''),
  DEPLOYMENT_SUFFIX:letterToken.or(z.literal('')).optional().default(''),
  AI_ENABLED:z.enum(['true','false']).optional().default('false'),OPENAI_API_KEY:optionalText,OPENAI_MODEL:optionalText,
  OPENAI_REASONING_EFFORT:z.enum(['','none','low','medium','high','xhigh','max']).optional().default(''),
});
export function setupEnvironment() {
  mkdirSync(state,{recursive:true,mode:0o700});
  for(const file of ['.env','.env.local','.env.prod']) {
    if(!existsSync(file)) {
      const initial=readFileSync(file+'.example','utf8');
      writeFileSync(file,file==='.env.local'?initial.replace('AUTH_SECRET=','AUTH_SECRET='+randomBytes(32).toString('hex')):initial,
        {mode:0o600,flag:'wx'});
    }
  }
}
export function environment(selected,{dryRun=false}={}) {
  if(selected!=='local'&&selected!=='prod') throw new Error('Select ENV=local or ENV=prod explicitly.');
  const override=readEnv('.env.'+selected);
  if(sharedModelSettings.some(key=>Object.hasOwn(override,key))) {
    throw new Error('Keep the OpenAI model and reasoning effort in the shared root .env.');
  }
  const data={...readEnv('.env'),...override};
  // CI can inject only these private values, and must explicitly opt in.
  if (selected==='prod' && process.env.BLOCKFIT_CI_INJECT==='true') {
    for (const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_TAG_API_TOKEN','AUTH_SECRET','OPENAI_API_KEY']) {
      if (process.env[key]) data[key]=process.env[key];
    }
  }
  const parsed=schema.safeParse(data);
  if(!parsed.success) throw new Error('Check configuration fields: '+parsed.error.issues.map(issue=>issue.path.join('.')).join(', '));
  const env=parsed.data;
  const origin=env.APP_ORIGIN?URL.parse(env.APP_ORIGIN):null;
  if(env.DEPLOYMENT!==selected || (env.APP_ORIGIN && origin?.origin!==env.APP_ORIGIN)) throw new Error('Environment or canonical app origin is incorrect.');
  if(selected==='local' && (!origin || origin.protocol!=='http:' || origin.hostname!=='127.0.0.1' || !origin.port)) {
    throw new Error('Local APP_ORIGIN must be an explicit http://127.0.0.1 port.');
  }
  const resourceName=[env.PROJECT_NAME,selected,env.DEPLOYMENT_SUFFIX].filter(Boolean).join('-');
  if (selected==='prod' && (!/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID) ||
      (!dryRun && !env.CONTACT_EMAIL) || !env.PAGES_PROJECT_NAME ||
      (origin && (origin.protocol!=='https:' || origin.port || !/^[a-z0-9][a-z0-9-]*\.pages\.dev$/.test(origin.hostname))))) {
    throw new Error('Production requires a valid Cloudflare account and Pages project name, plus a recovery email for live commands. If set, APP_ORIGIN must be the HTTPS pages.dev origin.');
  }
  if(/^gpt-6\.2-(sol|astra)(?:-|$)/.test(env.OPENAI_MODEL) && env.OPENAI_REASONING_EFFORT==='none') {
    throw new Error('GPT-6.2 Sol and Astra require reasoning effort of low or higher.');
  }
  if(env.AI_ENABLED==='true' && (!env.OPENAI_MODEL || !env.OPENAI_REASONING_EFFORT || !env.OPENAI_API_KEY)) {
    throw new Error('Live AI requires a shared model, reasoning effort, and an API key.');
  }
  return {...env,resourceName,origin};
}

export function writeConfig(env,{databaseId,directory=state}={}) {
  mkdirSync(state,{recursive:true,mode:0o700});
  const base=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const prod=env.DEPLOYMENT==='prod';
  const path=resolve(directory,prod?'prod.wrangler.json':'local.wrangler.json');
  const fromConfig=path=>relative(directory,resolve(path));
  const config={...base,name:env.resourceName,main:fromConfig(base.main),assets:{...base.assets,directory:fromConfig('dist')},
    vars:{APP_ORIGIN:env.APP_ORIGIN,DEPLOYMENT:env.DEPLOYMENT,CONTACT_EMAIL:env.CONTACT_EMAIL||'',
      AI_ENABLED:env.AI_ENABLED,OPENAI_MODEL:env.OPENAI_MODEL||'',
      OPENAI_REASONING_EFFORT:env.OPENAI_REASONING_EFFORT||''},
    d1_databases:[{...base.d1_databases[0],database_name:env.resourceName,migrations_dir:fromConfig('migrations')}],
  };
  if(prod) {
    if(!databaseId) throw new Error('A production D1 manifest is required.');
    config.account_id=env.CLOUDFLARE_ACCOUNT_ID;
    config.workers_dev=false;
    config.preview_urls=false;
    config.d1_databases[0].database_id=databaseId;
  }
  writeFileSync(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  return path;
}
function resolvedSecrets(env) {
  const secrets={AUTH_SECRET:env.AUTH_SECRET};
  if(env.AI_ENABLED==='true')secrets.OPENAI_API_KEY=env.OPENAI_API_KEY;
  return secrets;
}
export function secretsFile(env,config) {
  const path=resolve(dirname(config),env.DEPLOYMENT+'.secrets.json');
  writeFileSync(path,JSON.stringify(resolvedSecrets(env))+'\n',{mode:0o600});
  return path;
}
export function writeLocalSecrets(env,config) {
  const values=Object.entries(resolvedSecrets(env));
  if (values.some(([,value]) => /[\r\n'\0]/.test(value))) throw new Error('Local secrets must be single-line values without apostrophes.');
  writeFileSync(resolve(dirname(config),'.dev.vars'),values.map(([key,value])=>`${key}='${value}'`).join('\n')+'\n',{mode:0o600});
}
export function runtimeEnv(env) {
  const child={...process.env};
  for (const key of Object.keys(child)) {
    if (/^(CLOUDFLARE_|CF_|WRANGLER_|VITE_|AUTH_SECRET$|OPENAI_|AI_|APP_ORIGIN$|CONTACT_EMAIL$|DEPLOYMENT$)/.test(key)) delete child[key];
  }
  if ('NO_COLOR' in child) delete child.FORCE_COLOR;
  return {...child,CI:'true',WRANGLER_SEND_METRICS:'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',
    WRANGLER_LOG_PATH:resolve(state,'wrangler.log'),CLOUDFLARE_ENV:'',
    ...(env.DEPLOYMENT==='prod'?{CLOUDFLARE_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID,
      ...(env.CLOUDFLARE_API_TOKEN?{CLOUDFLARE_API_TOKEN:env.CLOUDFLARE_API_TOKEN}:{})}:{})};
}
export function run(command,args,env,{allowInterrupt=false,...options}={}) {
  const result=spawnSync(command,args,{stdio:'inherit',env:runtimeEnv(env),...options});
  if (allowInterrupt && (['SIGINT','SIGTERM'].includes(result.signal)||[130,143].includes(result.status))) return result.stdout;
  if (result.error || result.status!==0) throw new Error(`${command.split('/').pop()} failed${result.status===null?'':` (exit ${result.status})`}.`);
  return result.stdout;
}
export const bin=command=>resolve('node_modules','.bin',command);
export const persistPath=()=>process.env.BLOCKFIT_STORE?resolve(process.env.BLOCKFIT_STORE):resolve(state,'local-d1');
