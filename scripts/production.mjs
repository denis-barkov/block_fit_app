import {existsSync,mkdirSync,readFileSync,renameSync,rmSync,rmdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {bin,run,secretsFile,state,writeConfig} from './environment.mjs';
import {build,migrate,packageWorker} from './local.mjs';
import {applyTags,cloudflare,CloudflareError,validateAccount,wranglerCredential} from './cloudflare.mjs';
import {maintainAccount,provisionAccounts} from './accounts.mjs';
import {printDemoPlan,seedDataset,seedDemoGoals} from './fixtures.mjs';
import {dataCommand} from './snapshot.mjs';
import {remoteDatabase} from './remote-d1.mjs';
import {deployPages,findPagesProject,packagePages,pagesBranch,pagesProjectPath,verifiedPages} from './pages.mjs';
import {backupBeforeMigration,checkRelease,deployedWorkerVersion,migrationState,publishedVersions,
  recoverRelease,releaseCommit,uuid} from './release.mjs';

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
  if(value && (value.account!==env.CLOUDFLARE_ACCOUNT_ID||value.name!==env.resourceName||!uuid.test(value.databaseId) ||
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
  const [result,routes,domains]=await Promise.all([
    call(`/workers/scripts/${env.resourceName}/subdomain`),
    call(`/workers/services/${env.resourceName}/environments/production/routes`),
    call('/workers/domains/records?'+new URLSearchParams({service:env.resourceName,environment:'production',page:'0',per_page:'5'})),
  ]);
  if(result?.enabled!==false || (result?.previews_enabled??false)!==false ||
    !Array.isArray(routes) || routes.length || !Array.isArray(domains) || domains.length) {
    throw new Error('The backend Worker must have no public routes, custom domains or preview URLs.');
  }
}
export async function production(command,env,args) {
  if(!['release','recover','provision','deploy','db-migrate','seed','seed-goals','staff-create','password-reset','session-revoke',
    'snapshot','restore','suspend','resume','destroy','smoke-prod','seed-update','accounts-provision'].includes(command)) {
    throw new Error('This command is unavailable for prod.');
  }
  const call=cloudflare(env,fetch,wranglerCredential(env));
  await validateAccount(call,env);
  mkdirSync(state,{recursive:true,mode:0o700});
  const inventory=manifest(env);
  const release=command==='release';
  const provisions=['provision','release'].includes(command);
  const deploys=['deploy','release'].includes(command);
  const isDeployCommand=provisions||deploys;
  if(isDeployCommand && !['','yes','no'].includes(args[0]??'')) throw new Error('Use DRY_RUN=yes for a read-only preview.');
  const dryRun=isDeployCommand&&args[0]==='yes';
  const printTarget=record=>console.log(`Configured account · Pages ${env.PAGES_PROJECT_NAME} · Private Worker ${env.resourceName} · D1 ${record?'verified by manifest':'new database named '+env.resourceName}`);
  const tagCredential=env.CLOUDFLARE_TAG_API_TOKEN||env.CLOUDFLARE_API_TOKEN;
  const tagging=tagCredential?cloudflare(env,fetch,tagCredential):null;
  async function requireTagging() {
    if(!tagging) throw new Error('Set CLOUDFLARE_TAG_API_TOKEN in .env.prod for this account. The configured Wrangler login does not provide Resource Tagging access.');
    await tagging('/tags/keys');
  }
  async function scopedPages(record) {
    const project=await findPagesProject(call,env);
    if(project && !record?.pagesId) throw new Error('This Pages name already exists in the account. Choose another project name or recover its protected manifest.');
    if(record?.pagesId && (project || command!=='destroy')) verifiedPages(env,record,project);
    return project;
  }
  async function checkNames() {
    const found=await call('/d1/database?'+new URLSearchParams({name:env.resourceName}));
    if(found.some(db=>db.name===env.resourceName)||await lookup(call,bindingPath(env))) {
      throw new Error('A resource already uses this name. Recover its protected manifest or choose a new deployment suffix.');
    }
    await scopedPages(null);
  }
  if(dryRun && provisions&&!inventory.value) {
    await checkNames();
    printTarget(null);
    if(release) {
      const preview={...env,APP_ORIGIN:env.APP_ORIGIN||`https://${env.PAGES_PROJECT_NAME}.pages.dev`};
      const directory=resolve(state,'release-dry-run');
      mkdirSync(directory,{recursive:true,mode:0o700});
      packageWorker(preview,writeConfig(preview,{databaseId:'00000000-0000-4000-8000-000000000001',directory}),resolve(directory,'worker'));
      packagePages(preview,directory);
    }
    console.log('Dry run: provision would create D1 and Pages, discover the assigned hostname, and apply migrations.');
    if(release)console.log('Release would then apply explicitly selected initialization, deploy Worker and Pages, and run smoke checks.');
    if(!tagging) console.log('Resource Tagging still requires a scoped token before provisioning.');
    return;
  }
  const lock=inventory.path+'.lock';
  mkdirSync(lock,{mode:0o700});
  let phase='target verification';
  let commit;
  try {
    const dbPath='/d1/database';
    let project=await scopedPages(inventory.value);
    const directory=inventory.path+'.runtime';
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(isDeployCommand && !dryRun) await requireTagging();
    if(release && !dryRun) {
      if(!['','yes'].includes(args[1]??''))throw new Error('Use DEMO=yes to initialize the approved demo data and goals.');
      if(env.AI_ENABLED!=='true')throw new Error('Set AI_ENABLED=true in .env.prod before releasing the production beta.');
      if(!inventory.value)await checkNames();
      else await verifyBindings(call,env,inventory.value);
      commit=releaseCommit(env);
      printTarget(inventory.value);
      console.log(`Release ${commit.slice(0,12)} · Demo fixtures ${args[1]==='yes'?'requested':'unchanged'} · Named accounts ${args[2]?'requested':'unchanged'}`);
      phase='local release checks';
      const preview={...env,APP_ORIGIN:project?`https://${project.subdomain}`:env.APP_ORIGIN||`https://${env.PAGES_PROJECT_NAME}.pages.dev`};
      const prepared=writeConfig(preview,{databaseId:inventory.value?.databaseId??'00000000-0000-4000-8000-000000000001',directory});
      checkRelease(preview,prepared,directory);
      if(releaseCommit(env)!==commit)throw new Error('The release checkout changed during verification.');
    }
    if (provisions && !dryRun && !inventory.value) {
      phase='D1 provisioning';
      if(!release)await checkNames();
      const created=await call(dbPath,'POST',{name:env.resourceName});
      if(!uuid.test(created.uuid)||created.name!==env.resourceName)throw new Error('D1 returned an unexpected resource identifier.');
      inventory.write({account:env.CLOUDFLARE_ACCOUNT_ID,name:env.resourceName,databaseId:created.uuid});
    }
    let record=inventory.value;
    if(!record)throw new Error('Run provision for this exact account and deployment first.');
    if(provisions && !dryRun && !project) {
      phase='Pages provisioning';
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
    env={...env,databaseId:record.databaseId};
    const config=writeConfig(env,{databaseId:record.databaseId,directory});
    if(dryRun) {
      await verifyBindings(call,env,record);
      printTarget(record);
      if(deploys) {
        packageWorker(env,config);
        packagePages(env,directory);
      } else console.log('Dry run: provision would reconcile Pages, D1 and their tags, then apply pending migrations.');
      if(!tagging) console.log('Resource Tagging still requires a scoped token before a live operation.');
      return;
    }
    const db=remoteDatabase(call,record.databaseId);
    const useDB=callback=>callback(db);
    if(provisions) {
      phase='resource tags';
      await applyTags(tagging,env,'d1_database',record.databaseId,!record.databaseTagged);
      await applyTags(tagging,env,'pages_project',record.pagesId,!record.pagesTagged);
      record={...record,databaseTagged:true,pagesTagged:true};
      inventory.write(record);
      phase='backup and migrations';
      if(release)await backupBeforeMigration(db,env,config,directory);
      migrate(env,config);
      console.log(`D1 and Pages reconciled. Public origin: ${env.APP_ORIGIN}`);
    }
    if(command==='provision')return;
    if(deploys) {
      if(release && args[1]==='yes') {
        phase='demo data and goals';
        await seedDataset(db);
        await seedDemoGoals(db);
      }
      if(release && args[2]) {
        phase='named account provisioning';
        await provisionAccounts(db,env,[args[2]==='default'?'':args[2],'yes']);
      }
      phase='build and public asset verification';
      if(release && releaseCommit(env)!==commit)throw new Error('The release checkout changed after verification.');
      await verifyBindings(call,env,record);
      build(env);
      const pages=packagePages(env,directory);
      if(release && releaseCommit(env)!==commit)throw new Error('The release checkout changed during packaging.');
      if(!release)migrate(env,config);
      phase='private Worker deployment';
      const privateFile=secretsFile(env,config);
      try{run(bin('wrangler'),['deploy','--no-autoconfig','--config',config,'--secrets-file',privateFile],env);}
      finally{rmSync(privateFile,{force:true});}
      await verifyBindings(call,env,record,true);
      await validatePrivateWorker(call,env);
      await applyTags(tagging,env,'worker',env.resourceName,!record.workerTagged);
      record={...record,workerTagged:true};
      inventory.write(record);
      phase='Pages deployment';
      deployPages(env,pages);
      if(release) {
        phase='recording deployed versions';
        const {applied}=await migrationState(db);
        const versions=await publishedVersions(call,env,record);
        const published={...versions,commit,migrations:applied,origin:env.APP_ORIGIN,aiEnabled:env.AI_ENABLED==='true',
          model:env.OPENAI_MODEL,reasoningEffort:env.OPENAI_REASONING_EFFORT,smoke:'pending'};
        inventory.write({...record,published});
        phase='production smoke checks';
        if(await db.prepare('SELECT suspended FROM operations WHERE id=1').first('suspended')) {
          console.log('Deployment is suspended. Resume after reviewing the migration, then run make smoke-prod ENV=prod.');
          return;
        }
        try{await smokeRelease(db,record,published);}
        catch(error) {
          if(!record.lastVerified) {
            await db.prepare('UPDATE operations SET suspended=1 WHERE id=1').run();
            console.log('Initial deployment suspended after a failed smoke check.');
          }
          throw error;
        }
      }
      console.log(`Public demo: ${env.APP_ORIGIN}`);
    } else if(command==='db-migrate') migrate(env,config);
    else if(['seed','seed-goals'].includes(command)) {
      if(await prompt(`Type ${env.resourceName} to add illustrative records to this production pilot: `)!==env.resourceName) throw new Error('Seed cancelled.');
      await useDB(command==='seed-goals'?seedDemoGoals:seedDataset);
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
    } else if(command==='smoke-prod') {
      await verifyBindings(call,env,record,true);
      await validatePrivateWorker(call,env);
      const versions=record.published&&await publishedVersions(call,env,record);
      const matches=versions?.workerVersion===record.published?.workerVersion && versions?.pagesDeployment===record.published?.pagesDeployment;
      await smokeRelease(db,record,matches?record.published:null);
    } else if(command==='recover') {
      await verifyBindings(call,env,record,true);
      const known=await recoverRelease(call,db,env,record,args,prompt);
      await verifyBindings(call,env,record,true);
      await validatePrivateWorker(call,env);
      if(await deployedWorkerVersion(call,env)!==known.workerVersion)throw new Error('The expected Worker version is not active.');
      const active=await publishedVersions(call,env,record);
      if(active.pagesDeployment!==known.pagesDeployment)throw new Error('The expected Pages version is not active.');
      inventory.write({...record,published:{...known,smoke:'pending'}});
      console.log('Code recovered. Database and suspension state were preserved.');
    } else {
      await verifyBindings(call,env,record);
      await dataCommand(command,env,config,undefined,args,useDB);
    }
  } catch(error) {
    if(release)throw new Error(`Release stopped during ${phase}. Earlier steps may have completed. ${error.message}`);
    throw error;
  } finally {rmdirSync(lock);}

  async function smokeRelease(db,record,published) {
    const {smoke,checkPublicDeployment}=await import('./smoke.mjs');
    try {
      await checkPublicDeployment(env,published?.pagesAlias);
      await smoke(env,db);
    } catch(error) {
      if(published)inventory.write({...record,published:{...published,smoke:'failed'}});
      throw error;
    }
    if(!published)return;
    const verified={...published,smoke:'passed'};
    const previousVerified=record.lastVerified?.pagesDeployment===verified.pagesDeployment?record.previousVerified:record.lastVerified;
    inventory.write({...record,published:verified,lastVerified:verified,previousVerified});
  }
}
