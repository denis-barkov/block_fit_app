import {existsSync,mkdirSync,readFileSync,renameSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {bin,run,secretsFile,state,writeConfig} from './environment.mjs';
import {build,migrate,packageWorker} from './local.mjs';
import {applyTags,cloudflare,CloudflareError,validateAccount,wranglerCredential} from './cloudflare.mjs';
import {maintainAccount,provisionAccounts} from './accounts.mjs';
import {printDemoPlan,seedDataset} from './fixtures.mjs';
import {dataCommand} from './snapshot.mjs';
import {remoteDatabase} from './remote-d1.mjs';
import {ai} from '../config/settings.ts';
import {deployPages,findPagesProject,packagePages,pagesBranch,pagesProjectPath,verifiedPages} from './pages.mjs';

const token=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
async function prompt(label) {
  if(!process.stdin.isTTY)throw new Error('This action requires an interactive terminal.');
  const io=createInterface({input:process.stdin,output:process.stdout});
  try{return (await io.question(label)).trim();}
  finally{io.close();}
}
async function lookup(call,path) {
  try{return await call(path);}catch(error){if(error instanceof CloudflareError&&error.status===404)return null;throw error;}
}
function manifest(env) {
  const path=resolve(state,`prod-${env.CLOUDFLARE_ACCOUNT_ID}-${env.resourceName}.json`);
  let value=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
  if(value && (value.account!==env.CLOUDFLARE_ACCOUNT_ID||value.name!==env.resourceName||!token.test(value.databaseId) ||
      (value.pagesId && (typeof value.pagesId!=='string'||value.pagesName!==env.PAGES_PROJECT_NAME)))) {
    throw new Error('The protected deployment manifest does not match this target.');
  }
  return {
    get value(){return value;}, path,
    write(next) {
      const temporary=path+'.tmp';
      writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600});
      renameSync(temporary,path);value=next;
    },
  };
}
function bindingPath(env) {return `/workers/scripts/${env.resourceName}/settings`;}
async function verifyBindings(call,env,record,required=false) {
  const settings=await lookup(call,bindingPath(env));
  if(!settings&&required)throw new Error('The named Worker could not be found.');
  if(settings && !settings.bindings?.some(binding=>binding.name==='DB' && binding.type==='d1' && binding.id===record.databaseId)) {
    throw new Error('The named Worker is bound to a different database.');
  }
  return settings;
}

async function validatePrivateWorker(call,env) {
  const result=await call(`/workers/scripts/${env.resourceName}/subdomain`);
  if(result?.enabled!==false || (result?.previews_enabled??false)!==false) {
    throw new Error('The backend Worker must have workers.dev and version preview URLs disabled.');
  }
}
export async function production(command,env,args) {
  if(!['provision','deploy','db-migrate','seed','staff-create','password-reset','session-revoke',
    'snapshot','restore','suspend','resume','destroy','smoke-prod','ai-carry-forward','seed-update','accounts-provision'].includes(command)) {
    throw new Error('This command is unavailable for prod.');
  }
  const call=cloudflare(env,fetch,wranglerCredential(env));
  await validateAccount(call,env);
  mkdirSync(state,{recursive:true,mode:0o700});
  const inventory=manifest(env);
  const isDeployCommand=['provision','deploy'].includes(command);
  if(isDeployCommand && !['','yes','no'].includes(args[0]??'')) throw new Error('Use DRY_RUN=yes for a read-only preview.');
  const dryRun=isDeployCommand&&args[0]==='yes';
  const printTarget=record=>console.log(`Account ${env.CLOUDFLARE_ACCOUNT_ID} · Pages ${env.PAGES_PROJECT_NAME} · Private Worker ${env.resourceName} · D1 ${record?.databaseId??'new database named '+env.resourceName}`);
  const tagCredential=env.CLOUDFLARE_TAG_API_TOKEN||env.CLOUDFLARE_API_TOKEN;
  const tagging=tagCredential?cloudflare(env,fetch,tagCredential):null;
  async function requireTagging() {
    if(!tagging) throw new Error('Configure an account-owned Resource Tagging token. Wrangler OAuth can provision resources but cannot apply their required tags.');
    await tagging('/tags/keys');
  }
  async function scopedPages(record) {
    const project=await findPagesProject(call,env);
    if(project && !record?.pagesId) throw new Error('This Pages name already exists in the account. Choose another project name or recover its protected manifest.');
    if(record?.pagesId && (project || command!=='destroy')) verifiedPages(env,record,project);
    return project;
  }
  if(dryRun && command==='provision'&&!inventory.value) {
    const found=await call('/d1/database?'+new URLSearchParams({name:env.resourceName}));
    if(found.some(db=>db.name===env.resourceName)||await lookup(call,bindingPath(env))) {
      throw new Error('A resource already uses this name. Recover its protected manifest or choose a new deployment suffix.');
    }
    await scopedPages(null);
    printTarget(null);
    console.log('Dry run: provision would create D1 and the Pages project, discover the assigned hostname, and apply migrations.');
    if(!tagging) console.log('Resource Tagging still requires a scoped token before provisioning.');
    return;
  }
  const lock=inventory.path+'.lock';
  mkdirSync(lock,{mode:0o700});
  try {
    const dbPath='/d1/database';
    let project=await scopedPages(inventory.value);
    if(!dryRun && ['provision','deploy'].includes(command)) await requireTagging();
    if (command==='provision' && !inventory.value) {
      const found=await call(dbPath+'?'+new URLSearchParams({name:env.resourceName}));
      if(found.some(db=>db.name===env.resourceName)||await lookup(call,bindingPath(env))) {
        throw new Error('A resource already uses this name. Recover its protected manifest or choose a new deployment suffix.');
      }
      const created=await call(dbPath,'POST',{name:env.resourceName});
      if(!token.test(created.uuid)||created.name!==env.resourceName)throw new Error('D1 returned an unexpected resource identifier.');
      inventory.write({account:env.CLOUDFLARE_ACCOUNT_ID,name:env.resourceName,databaseId:created.uuid});
    }
    let record=inventory.value;
    if(!record)throw new Error('Run provision for this exact account and deployment first.');
    if(command==='provision' && !dryRun && !project) {
      project=await call('/pages/projects','POST',{name:env.PAGES_PROJECT_NAME,production_branch:pagesBranch});
      if(!project?.id || project.name!==env.PAGES_PROJECT_NAME) throw new Error('Cloudflare returned an unexpected Pages project.');
      record={...record,pagesId:project.id,pagesName:project.name};
      inventory.write(record);
    }
    if(project) env=verifiedPages(env,record,project);
    else if(!dryRun && !['destroy','db-migrate'].includes(command)) throw new Error('Provision the Pages project before managing this deployment.');
    else if(dryRun && command==='deploy') throw new Error('Provision the Pages project before preparing its deployment.');
    const namedDB=await lookup(call,`${dbPath}/${record.databaseId}`);
    if(!namedDB||namedDB.uuid!==record.databaseId||namedDB.name!==env.resourceName) {
      throw new Error('The manifest database cannot be verified in the selected account.');
    }
    const directory=inventory.path+'.runtime';
    mkdirSync(directory,{recursive:true,mode:0o700});
    const config=writeConfig(env,{databaseId:record.databaseId,directory});
    if(dryRun) {
      await verifyBindings(call,env,record);
      printTarget(record);
      if(command==='deploy') {
        packageWorker(env,config);
        packagePages(env,directory);
      } else console.log('Dry run: provision would reconcile Pages, D1 and their tags, then apply pending migrations.');
      if(!tagging) console.log('Resource Tagging still requires a scoped token before a live operation.');
      return;
    }
    const db=remoteDatabase(call,record.databaseId);
    const useDB=callback=>callback(db);
    if(command==='provision') {
      await applyTags(tagging,env,'d1_database',record.databaseId,!record.databaseTagged);
      await applyTags(tagging,env,'pages_project',record.pagesId,!record.pagesTagged);
      inventory.write({...record,databaseTagged:true,pagesTagged:true});
      migrate(env,config);
      console.log(`D1 and Pages reconciled. Public origin: ${env.APP_ORIGIN}`);
    } else if(command==='deploy') {
      await verifyBindings(call,env,record);
      build(env);
      migrate(env,config);
      const privateFile=secretsFile(env,config);
      try{run(bin('wrangler'),['deploy','--no-autoconfig','--config',config,'--secrets-file',privateFile],env);}
      finally{rmSync(privateFile,{force:true});}
      await verifyBindings(call,env,record,true);
      await validatePrivateWorker(call,env);
      await applyTags(tagging,env,'worker',env.resourceName,!record.workerTagged);
      inventory.write({...record,workerTagged:true});
      deployPages(env,directory);
      console.log(`Public demo: ${env.APP_ORIGIN}`);
    } else if(command==='db-migrate') migrate(env,config);
    else if(command==='seed') {
      if(await prompt(`Type ${env.resourceName} to add illustrative records to this production pilot: `)!==env.resourceName) throw new Error('Seed cancelled.');
      await useDB(seedDataset);
    } else if(command==='seed-update') {
      printTarget(record);
      const plan=await printDemoPlan(db);
      if(args[0]!=='yes') {console.log('Preview only. Use APPLY=yes after reviewing the plan.');return;}
      if(plan.version>=plan.target)return;
      if(await prompt(`Type ${env.resourceName} to replace the old demo fixture: `)!==env.resourceName) throw new Error('Fixture update cancelled.');
      await seedDataset(db,{update:true});
      console.log(`Demo fixture v${plan.target} installed.`);
    } else if(command==='accounts-provision') {
      printTarget(record);
      await provisionAccounts(db,env,args);
    } else if(['staff-create','password-reset','session-revoke'].includes(command)) {
      await useDB(db=>maintainAccount(command,db,env));
    } else if(command==='destroy') {
      const worker=await verifyBindings(call,env,record);
      const expected=`${record.pagesName??'no-pages'} ${env.resourceName} ${record.databaseId}`;
      if(await prompt(`Account ${record.account}. Verify backups, then type "${expected}" to continue: `)!==expected) {
        throw new Error('Destroy cancelled.');
      }
      const mode=await prompt('Type RETAIN or DELETE for the database: ');
      if(!['RETAIN','DELETE'].includes(mode))throw new Error('Destroy cancelled.');
      if(record.pagesId) {
        if(project) await call(pagesProjectPath(env),'DELETE');
        const {pagesId,pagesName,pagesTagged,...retained}=record;
        record=retained;
        inventory.write(record);
      }
      if(worker) await call(`/workers/scripts/${env.resourceName}`,'DELETE');
      if(mode==='DELETE') {
        await call(`${dbPath}/${record.databaseId}`,'DELETE');
        rmSync(inventory.path,{force:true});
      } else inventory.write({...record,workerTagged:false});
      console.log(mode==='DELETE'?'Named Pages project, Worker and D1 database removed.':'Named Pages project and Worker removed. D1 retained.');
    } else if(command==='restore') {
      if(await lookup(call,bindingPath(env)))throw new Error('Restore requires a separately named D1 target without a deployed Worker.');
      await dataCommand(command,env,config,undefined,args,useDB);
    } else if(command==='ai-carry-forward') {
      const value=await prompt('After validating prior spend and outstanding reservations, enter the lifetime floor in microdollars: ');
      const attempts=await prompt('Enter the previous instance’s attempts for today (UTC): ');
      if(!/^\d{1,12}$/.test(value)||!/^\d{1,3}$/.test(attempts)||Number(attempts)>ai.daily)throw new Error('A valid spending floor and daily total are required.');
      await useDB(db=>db.batch([
        db.prepare('UPDATE ai_total SET spent=max(spent,?) WHERE id=1').bind(Number(value)),
        db.prepare('INSERT INTO ai_day VALUES (?,?) ON CONFLICT(day) DO UPDATE SET attempts=max(attempts,excluded.attempts)')
          .bind(new Date().toISOString().slice(0,10),Number(attempts)),
        db.prepare('UPDATE operations SET ai_frozen=0 WHERE id=1'),
      ]));
      console.log('AI ledger reconciled. The deployment must separately enable live AI.');
    } else if(command==='smoke-prod') {
      await verifyBindings(call,env,record,true);
      await validatePrivateWorker(call,env);
      const {smoke}=await import('./smoke.mjs');
      await smoke(env,db);
    } else {
      await verifyBindings(call,env,record);
      await dataCommand(command,env,config,undefined,args,useDB);
    }
  } finally {rmdirSync(lock);}
}
