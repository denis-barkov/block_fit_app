import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {state} from './environment.mjs';
import {migrate,withDB} from './local.mjs';
import {seedDataset} from './fixtures.mjs';
import {candidateInput,coordinate,equipmentInput,parkInput} from '../src/contracts.ts';
import project from '../package.json' with {type:'json'};

const columns={
  user:'id name email emailVerified image createdAt updatedAt role banned banReason banExpires purpose',
  account:'id accountId providerId userId accessToken refreshToken idToken accessTokenExpiresAt refreshTokenExpiresAt scope password createdAt updatedAt',
  locations:'owner lat lng label updated_at use_for_requests',
  removed_locations:'id owner lat lng label removed_at',
  demand:'id owner category lat lng status note suggestion suggested_lat suggested_lng created_at confirmed_at',
  parks:'id name lat lng external_id source hours archived city_maintained fixture',
  equipment:'id name category lat lng park_id condition access source verified_on visible archived fixture',
  candidates:'id name category lat lng park_id feasibility costs notes project_url archived fixture',
  synthetic_demand:'id category lat lng',
  ai_day:'day attempts',
};
const publicTables=['parks','equipment','candidates','synthetic_demand'];
const migration='0005_resident_travel.sql';
const legacyIds={parks:['demo-west','demo-east'],equipment:['demo-bars','demo-parallel','demo-bench'],candidates:['demo-a','demo-b','demo-c']};
const {version}=project;

const privateTables=Object.keys(columns);
function names(table) {return columns[table].split(' ');}
async function readTables(db,tables) {
  const result=await db.batch(tables.map(table=>db.prepare(`SELECT ${names(table).join(',')} FROM ${table}`)));
  return Object.fromEntries(tables.map((table,index)=>[table,result[index].results]));
}
export async function createSnapshot(db,mode) {
  const tables=mode==='demo'?publicTables:privateTables;
  const spend=await db.prepare('SELECT spent FROM ai_total WHERE id=1').first('spent');
  const demoVersion=await db.prepare('SELECT demo_version FROM operations WHERE id=1').first('demo_version');
  return {version,migration,demoVersion,mode,exportedAt:new Date().toISOString(),spent:mode==='demo'?0:spend,records:await readTables(db,tables)};
}
function validateRecord(table,row) {
  const {id,archived,fixture,...data}=row;
  if (table==='parks') {
    const {external_id,city_maintained,...park}=data;
    parkInput.parse({...park,externalId:external_id,cityMaintained:Boolean(city_maintained)});
  } else if (table==='equipment') {
    const {park_id,verified_on,visible,...equipment}=data;
    equipmentInput.parse({...equipment,parkId:park_id,verifiedOn:verified_on,visible:Boolean(visible)});
  } else if (table==='candidates') {
    const {park_id,project_url,costs,...candidate}=data;
    candidateInput.parse({...candidate,parkId:park_id,projectUrl:project_url,costs:JSON.parse(costs)});
  } else if (['locations','removed_locations','demand','synthetic_demand'].includes(table)) {
    coordinate.parse({lat:row.lat,lng:row.lng});
  }
}
export async function restoreSnapshot(db,snapshot) {
  const legacy=snapshot?.version==='0.0.1' && snapshot.migration==='0002_pilot_operations.sql';
  const priorLocations=snapshot?.migration==='0003_demo_and_account_purpose.sql' && /^0\.0\.[2-6]$/.test(snapshot.version);
  const current=snapshot?.migration===migration && [version,'0.2.0','0.2.1'].includes(snapshot.version);
  const priorTravel=snapshot?.migration==='0004_request_locations.sql' && /^0\.1\.[01]$/.test(snapshot.version);
  if (!snapshot || (!legacy && (!(current || priorTravel || priorLocations) || ![0,1,2].includes(snapshot.demoVersion))) ||
    !['demo','private'].includes(snapshot.mode) || !Number.isSafeInteger(snapshot.spent) || snapshot.spent<0) {
    throw new Error('This snapshot version, schema or mode is incompatible.');
  }
  const tables=snapshot.mode==='demo'?publicTables:privateTables;
  const manifest = legacy || priorLocations ? tables.filter(table=>table!=='removed_locations') : tables;
  if (!snapshot.records || Object.keys(snapshot.records).sort().join()!==[...manifest].sort().join()) {
    throw new Error('Snapshot table manifest is invalid.');
  }
  const present=await db.batch(privateTables.filter(table=>table!=='ai_day')
    .map(table=>db.prepare(`SELECT count(*) AS n FROM ${table}`)));
  if (present.some(result=>Number(result.results[0]?.n)>0)) throw new Error('Restore requires an empty target.');
  const statements=[];
  for(const table of tables) {
    const entries=manifest.includes(table)?snapshot.records[table]:[];
    if(!Array.isArray(entries))throw new Error('Snapshot records are invalid.');
    const fields=names(table);
    for(const record of entries) {
      const entry=(legacy || priorLocations) && record && table==='locations' ? {...record,use_for_requests:1}
        : legacy && record && legacyIds[table] ? {...record,fixture:Number(legacyIds[table].includes(record.id))}
        : legacy && record && table==='user' ? {...record,purpose:null} : record;
      if(!entry || Object.keys(entry).sort().join()!==[...fields].sort().join() ||
        fields.some(field=>!['string','number'].includes(typeof entry[field])&&entry[field]!==null)) {
        throw new Error('Snapshot record fields are invalid.');
      }
      validateRecord(table,entry);
      if(table==='ai_day') {
        statements.push(db.prepare(`INSERT INTO ai_day(day,attempts) VALUES (?,?)
          ON CONFLICT(day) DO UPDATE SET attempts=max(attempts,excluded.attempts)`).bind(entry.day,entry.attempts));
      } else {
        statements.push(db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`)
          .bind(...fields.map(field=>entry[field])));
      }
    }
  }
  await db.batch([
    db.prepare('UPDATE operations SET suspended=1,ai_frozen=1,demo_version=? WHERE id=1').bind(
      legacy?Number(snapshot.records.synthetic_demand.length>0):snapshot.demoVersion),
    ...statements,
    db.prepare('UPDATE ai_total SET spent=max(spent,?) WHERE id=1').bind(snapshot.spent),
    db.prepare('DELETE FROM session'),
    db.prepare('DELETE FROM ai_jobs'),
    db.prepare('UPDATE revision SET value=value+1 WHERE id=1'),
  ]);
  const actual=await readTables(db,tables);
  const broken=await db.prepare('PRAGMA foreign_key_check').all();
  if(broken.results.length || tables.some(table=>table!=='ai_day' && actual[table].length!==(snapshot.records[table]?.length ?? 0))) {
    throw new Error('Restored data did not validate. The target remains suspended.');
  }
}

async function cleanDemo(env,config) {
  mkdirSync(state,{recursive:true,mode:0o700});
  const clean=mkdtempSync(join(state,'demo-export-'));
  try {
    migrate(env,config,clean);
    return await withDB(env,config,async db=>{await seedDataset(db);return createSnapshot(db,'demo');},clean);
  } finally {rmSync(clean,{recursive:true,force:true});}
}
export async function dataCommand(command,env,config,persist,[filename,selectedMode],useDB=callback=>withDB(env,config,callback,persist)) {
  if (!['snapshot','restore','suspend','resume'].includes(command)) throw new Error('Unknown operation. Run make help.');
  const local=env.DEPLOYMENT==='local';
  if (command==='snapshot'||command==='restore') {
    if (!filename) throw new Error('Specify SNAPSHOT as the path to a portable JSON data file.');
    const path=resolve(filename);
    if (command==='snapshot') {
      const mode=selectedMode||'private';
      if (!['private','demo'].includes(mode)) throw new Error('Select MODE=private or MODE=demo.');
      if (!path.startsWith(state+'/') && mode==='private' && path.startsWith(resolve('.')+'/')) {
        throw new Error('Keep private snapshots under .blockfit/ or outside the checkout.');
      }
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      let result;
      if (mode==='demo') {
        if(!local) throw new Error('Create the sanitized dataset with ENV=local MODE=demo.');
        result=await cleanDemo(env,config);
      } else result=await useDB(async db=>{
        if(!await db.prepare('SELECT suspended FROM operations WHERE id=1').first('suspended')) {
          throw new Error('Suspend the app and let in-flight requests finish before exporting a private snapshot.');
        }
        return createSnapshot(db,mode);
      });
      writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log('Snapshot written.');return;
    }
    if (local && (!process.env.BLOCKFIT_STORE || existsSync(persist))) {
      throw new Error('Set BLOCKFIT_STORE to a new directory for an isolated local restore.');
    }
    const snapshot=JSON.parse(readFileSync(path,'utf8'));
    migrate(env,config,persist);
    await useDB(db=>restoreSnapshot(db,snapshot));
    console.log('Snapshot restored and validated. The target stays suspended until resume; AI stays frozen.');return;
  }
  await useDB(db=>db.prepare('UPDATE operations SET suspended=? WHERE id=1').bind(Number(command==='suspend')).run());
  console.log(command==='suspend'?'Application suspended.':'Application resumed.');
}
