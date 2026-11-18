import {resolve} from 'node:path';
import {existsSync,mkdirSync,renameSync} from 'node:fs';
import {environment,persistPath,setupEnvironment,state,writeConfig} from './environment.mjs';
import {build,localDev,migrate,packageWorker,withDB} from './local.mjs';
import {localAccounts,seedDataset} from './fixtures.mjs';
import {maintainAccount} from './accounts.mjs';

const [command,selected,confirmation]=process.argv.slice(2);
try {
  if(command==='setup')setupEnvironment();
  const env=environment(selected);
  if(command==='build') build(env);
  else if(command==='package') packageWorker(env,writeConfig(env,{databaseId:'00000000-0000-4000-8000-000000000001'}));
  else if(selected==='local') {
    const path=writeConfig(env);
    const persist=persistPath();
    if (command==='dev') await localDev(env,path,persist);
    else if(command==='db-migrate') migrate(env,path,persist);
    else if(['setup','seed','reset-local'].includes(command)) {
      if(command==='reset-local') {
        if(confirmation!=='local'||process.env.BLOCKFIT_STORE) throw new Error('Use ENV=local RESET=local with the default local store to reset.');
        if(existsSync(persist)) {
          const backup=resolve(state,'local-d1-before-reset-'+Date.now());
          renameSync(persist,backup);
          console.log('Previous local database moved to '+backup);
        }
      }
      if(command!=='seed')migrate(env,path,persist);
      const accountsDir=process.env.BLOCKFIT_STORE?persist:state;
      mkdirSync(accountsDir,{recursive:true,mode:0o700});
      await withDB(env,path,async db=>{
        await seedDataset(db);
        await localAccounts(db,env,accountsDir);
      },persist);
      console.log('Local demo initialized. Demo logins are in the ignored demo-accounts.json file.');
    } else if(['staff-create','password-reset','session-revoke'].includes(command)) {
      await withDB(env,path,db=>maintainAccount(command,db,env),persist);
    } else {
      const {dataCommand}=await import('./snapshot.mjs');
      await dataCommand(command,env,path,persist,process.argv.slice(4));
    }
  } else {
    const {production}=await import('./production.mjs');
    await production(command,env,process.argv.slice(4));
  }
} catch (error) {
  console.error(error.message || 'The operation failed.');
  process.exitCode=1;
}
