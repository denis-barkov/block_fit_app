import {mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {run,bin} from './environment.mjs';
import {packageWorker} from './local.mjs';
import {packagePages,pagesProjectPath,verifiedPages} from './pages.mjs';

export const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const migrations=readdirSync('migrations').filter(name=>/^\d+_.+\.sql$/.test(name)).sort();

function git(env,args) {
  return run('git',args,env,{stdio:['ignore','pipe','inherit'],encoding:'utf8'}).trim();
}

export function releaseCommit(env) {
  if(git(env,['status','--porcelain']))throw new Error('Commit the release and begin with a clean checkout.');
  return git(env,['rev-parse','HEAD']);
}

export function checkRelease(env,config,directory) {
  run('make',['-j1','check','test','test-browser'],env);
  packageWorker(env,config,join(directory,'worker-check'));
  packagePages(env,directory);
}

export async function migrationState(db) {
  const result=await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
  const names=result.results.map(row=>row.name);
  const applied=names.includes('d1_migrations')
    ? (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(row=>row.name)
    : [];
  if(applied.some((name,index)=>name!==migrations[index]) || (!applied.length&&names.some(name=>name!=='d1_migrations'))) {
    throw new Error('The database does not have a recognized migration history. Inspect it before releasing.');
  }
  return {applied, pending:migrations.slice(applied.length), populated:applied.length>0};
}

export async function backupBeforeMigration(db,env,config,directory) {
  const schema=await migrationState(db);
  if(!schema.pending.length) {
    console.log('Database schema is current.');
    return;
  }
  if(!schema.populated) {
    console.log('First deployment: no application schema or data to back up.');
    return;
  }
  if(!await db.prepare('SELECT suspended FROM operations WHERE id=1').first('suspended')) {
    throw new Error('Suspend the existing deployment and let writes drain before running a release with migrations.');
  }
  const backupDirectory=join(directory,'backups');
  mkdirSync(backupDirectory,{recursive:true,mode:0o700});
  const output=join(backupDirectory,`before-${schema.pending[0].replace(/\.sql$/,'')}-${Date.now()}.sql`);
  // Export the existing schema, which may predate the portable snapshot's column set.
  run(bin('wrangler'),['d1','export','DB','--remote','--config',config,'--output',output],env);
  console.log('Pre-migration D1 snapshot saved in the protected deployment directory.');
}

export async function deployedWorkerVersion(call,env) {
  const {deployments}=await call(`/workers/scripts/${env.resourceName}/deployments`);
  const [active]=deployments??[];
  if(active?.versions?.length!==1 || active.versions[0].percentage!==100 || !uuid.test(active.versions[0].version_id)) {
    throw new Error('Cloudflare did not report a single active Worker version.');
  }
  return active.versions[0].version_id;
}

export async function publishedVersions(call,env,record) {
  const workerVersion=await deployedWorkerVersion(call,env);
  const project=await call(pagesProjectPath(env));
  verifiedPages(env,record,project);
  const pages=project.canonical_deployment;
  if(pages?.environment!=='production' || !uuid.test(pages.id)) {
    throw new Error('Cloudflare did not report a canonical production Pages deployment.');
  }
  return {workerVersion,pagesDeployment:pages.id,pagesAlias:pages.url};
}

export async function recoverRelease(call,db,env,record,[pagesDeployment,workerVersion],prompt) {
  if(!uuid.test(pagesDeployment??'') || !uuid.test(workerVersion??'')) {
    throw new Error('Supply explicit PAGES_DEPLOYMENT and WORKER_VERSION identifiers from a verified release.');
  }
  const known=[record.lastVerified,record.previousVerified].find(item=>
    item?.pagesDeployment===pagesDeployment && item.workerVersion===workerVersion);
  if(!known)throw new Error('The Pages and Worker pair was not verified by this target’s release workflow.');
  const {applied}=await migrationState(db);
  if(applied.join()!==known.migrations?.join())throw new Error('The known-good release does not match the current migration level.');
  if(!await db.prepare('SELECT suspended FROM operations WHERE id=1').first('suspended')) {
    throw new Error('Suspend this deployment before recovering code.');
  }
  const pagesPath=`${pagesProjectPath(env)}/deployments/${pagesDeployment}`;
  const workerPath=`/workers/scripts/${env.resourceName}`;
  const [pages,worker]=await Promise.all([call(pagesPath),call(`${workerPath}/versions/${workerVersion}`)]);
  if(pages?.id!==pagesDeployment || pages.environment!=='production' || worker?.id!==workerVersion) {
    throw new Error('The requested versions could not be verified against this deployment.');
  }
  if(await prompt(`Type ${env.resourceName} to recover this deployment’s code: `)!==env.resourceName) {
    throw new Error('Code recovery cancelled.');
  }
  await call(`${workerPath}/deployments`,'POST',{strategy:'percentage',versions:[{version_id:workerVersion,percentage:100}]});
  console.log('Worker recovered. Applying the matching Pages deployment.');
  await call(`${pagesPath}/rollback`,'POST');
  return known;
}
