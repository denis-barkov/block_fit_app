import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {bin,environment,persistPath,setupEnvironment,state,writeConfig} from './environment.mjs';
import {localDev,migrate,withDB} from './local.mjs';
import {localAccounts,seedDataset} from './fixtures.mjs';

setupEnvironment();
const env=environment('local');
if(process.argv[2]==='serve') {
  if(!process.env.BLOCKFIT_STORE)throw new Error('Set an isolated browser test store.');
  const store=persistPath();
  env.APP_ORIGIN=process.env.BLOCKFIT_BROWSER_ORIGIN;
  env.origin=new URL(env.APP_ORIGIN);
  env.AI_ENABLED='false';
  env.OPENAI_API_KEY='';
  env.CONTACT_EMAIL='contact@blockfit.example';
  const path=writeConfig(env,{directory:store});
  mkdirSync(store,{recursive:true,mode:0o700});
  migrate(env,path,store);
  await withDB(env,path,async db=>{
    await seedDataset(db);
    await localAccounts(db,env,store);
  },store);
  await localDev(env,path,store);
} else {
  const store=mkdtempSync(join(state,'browser-test-'));
  try {
    const server=createServer();
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    await new Promise(resolve=>server.close(resolve));
    const run=spawnSync(bin('playwright'),['test',...process.argv.slice(2)],{stdio:'inherit',
      env:{...process.env,BLOCKFIT_STORE:store,BLOCKFIT_BROWSER_ORIGIN:origin}});
    process.exitCode=run.status??1;
  } finally {rmSync(store,{force:true,recursive:true});}
}
