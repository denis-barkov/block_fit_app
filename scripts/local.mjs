import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {getPlatformProxy} from 'wrangler';
import {bin,persistPath,run,runtimeEnv,writeLocalSecrets,state} from './environment.mjs';

export function migrate(env,path,persist=persistPath()) {
  const local=env.DEPLOYMENT==='local';
  run(bin('wrangler'),['d1','migrations','apply','DB','--config',path,local?'--local':'--remote',
    ...(local?['--persist-to',persist]:[])],env);
}
export function build(env) {run(bin('vite'),['build'],env);}
export async function localDev(env,path,persist=persistPath()) {
  const port=createServer();
  try {
    await new Promise((resolve,reject)=>port.once('error',reject).listen(Number(env.origin.port),'127.0.0.1',resolve));
    await new Promise(resolve=>port.close(resolve));
  } catch (error) {
    if(error.code==='EADDRINUSE') throw new Error('APP_ORIGIN port is in use. Choose a free loopback port in .env.local.');
    throw error;
  }
  build(env);
  writeLocalSecrets(env,path);
  const args=['dev','--local','--config',path,'--ip','127.0.0.1',
    '--port',env.origin.port,'--persist-to',persist];
  run(bin('wrangler'),args,env,{allowInterrupt:true});
}
export async function withDB(env,config,callback,persist=persistPath()) {
  const original=process.env;
  if(env.DEPLOYMENT!=='local')throw new Error('The local D1 emulator cannot target production.');
  mkdirSync(persist,{recursive:true,mode:0o700});
  process.env=runtimeEnv(env);
  try {
    const proxy=await getPlatformProxy({configPath:config,remoteBindings:false,persist:{path:resolve(persist,'v3')},envFiles:[]});
    try {return await callback(proxy.env.DB);}
    finally {await proxy.dispose();}
  } finally {process.env=original;}
}
export function packageWorker(env,config) {
  build(env);
  mkdirSync(state,{recursive:true,mode:0o700});
  run(bin('wrangler'),['deploy','--dry-run','--no-autoconfig','--config',config,'--outdir',resolve(state,'worker')],env);
}
