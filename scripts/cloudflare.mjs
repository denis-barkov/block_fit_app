import {spawnSync} from 'node:child_process';
import {bin,runtimeEnv} from './environment.mjs';

export class CloudflareError extends Error {
  constructor(status,path) {super(`Cloudflare request failed (${status}) at ${path.split('?')[0]}.`);this.status=status;}
}
export function cloudflare(env,transport=fetch,credential=env.CLOUDFLARE_API_TOKEN) {
  const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  return async (path,method='GET',data)=>{
    const response=await transport(base+path,{method,headers:{Authorization:`Bearer ${credential}`,
      'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(30_000)});
    if(response.status===204)return null;
    if(!response.ok)throw new CloudflareError(response.status,path);
    const result=await response.json();
    if(!result.success)throw new CloudflareError(response.status,path);
    return result.result;
  };
}
export async function applyTags(call,env,type,id,initial) {
  const target={resource_type:type,resource_id:id};
  let current;
  try {current=(await call('/tags?'+new URLSearchParams(target))).tags;}
  catch(error) {
    // The initial GET for an untagged resource currently returns HTTP 500.
    if (!initial || !(error instanceof CloudflareError) || ![404,500].includes(error.status)) throw error;
    current={};
  }
  const tags={...current,'project-name':env.PROJECT_NAME,environment:env.DEPLOYMENT,'managed-by':env.MANAGED_BY,
    ...(env.SERVICE_PART?{'service-part':env.SERVICE_PART}:{}),...(env.FUNDING?{funding:env.FUNDING}:{})};
  await call('/tags','PUT',{...target,tags});
}
export async function validateAccount(call,env) {
  const account=await call('');
  if(account?.id!==env.CLOUDFLARE_ACCOUNT_ID)throw new Error('The token target does not match the configured account.');
}

export function wranglerCredential(env) {
  if(env.CLOUDFLARE_API_TOKEN)return env.CLOUDFLARE_API_TOKEN;
  const result=spawnSync(bin('wrangler'),['auth','token','--json'],{
    env:runtimeEnv(env),encoding:'utf8',stdio:['ignore','pipe','pipe'],
  });
  let response;
  try {response=JSON.parse(result.stdout);}
  catch { /* Never print CLI output that could contain credentials. */ }
  if(result.status!==0 || response?.type!=='oauth' || !response.token) {
    throw new Error('Sign in with Wrangler or supply a scoped Cloudflare API token.');
  }
  return response.token;
}
