import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {createAuth} from '../src/server/auth.ts';
import {demoCandidates,demoDemand,demoEquipment,demoParks,demoVersion,illustrative,legacyDemandIds,simulated} from '../config/demo.ts';

const versionQuery='SELECT demo_version FROM operations WHERE id=1';
const records = {
  parks: demoParks.map(([id,name,lat,lng])=>({id,name,lat,lng,external_id:'',source:illustrative,hours:'',city_maintained:0,archived:0,fixture:1})),
  equipment: demoEquipment.map(([id,name,category,lat,lng,park_id,condition,access,verified])=>({
    id,name,category,lat,lng,park_id,condition,access,source:verified?simulated:illustrative,
    verified_on:verified?'2026-11-18':null,visible:1,archived:0,fixture:1,
  })),
  candidates: demoCandidates.map(([id,name,category,lat,lng,park_id,feasibility,costs,notes])=>({
    id,name,category,lat,lng,park_id,feasibility,costs:JSON.stringify(costs),notes:'Illustrative demo candidate. '+notes,
    project_url:null,archived:0,fixture:1,
  })),
  synthetic_demand:demoDemand(),
};
const counts=Object.fromEntries(Object.entries(records).map(([name,rows])=>[name,rows.length]));
export async function demoPlan(db) {
  const [version,...summary]=await db.batch([
    db.prepare(versionQuery),
    ...Object.keys(records).map(table=>db.prepare(table==='synthetic_demand'?
      'SELECT count(*) AS n FROM synthetic_demand WHERE id IN ('+legacyDemandIds.map(()=>'?').join(',')+') OR id LIKE ?' :
      `SELECT count(*) AS n FROM ${table} WHERE fixture=1`)
      .bind(...(table==='synthetic_demand'?[...legacyDemandIds,'demo-v2-demand-%']:[]))),
  ]);
  return {version:version.results[0].demo_version, target:demoVersion,
    current:Object.fromEntries(Object.keys(records).map((name,index)=>[name,summary[index].results[0].n])),counts};
}

export async function seedDataset(db,{update=false}={}) {
  const current=await db.prepare(versionQuery).first('demo_version');
  if(current>=demoVersion || (current!==0&&!update))return current;
  // Guard each statement with the same version. The final write advances it after the atomic batch.
  const guard='(SELECT demo_version FROM operations WHERE id=1)=?';
  const writes=Object.entries(records).flatMap(([table,rows])=>{
    const fields=Object.keys(rows[0]);
    const updates=fields.filter(field=>field!=='id').map(field=>`${field}=excluded.${field}`).join(',');
    const conflict=table==='synthetic_demand'?'DO NOTHING':`DO UPDATE SET ${updates} WHERE ${table}.fixture=1`;
    const tuple='('+fields.map(()=>'?').join(',')+')';
    const size=Math.floor(99/fields.length);
    return Array.from({length:Math.ceil(rows.length/size)},(_,index)=>{
      const chunk=rows.slice(index*size,(index+1)*size);
      return db.prepare(`WITH input(${fields.join(',')}) AS (VALUES ${chunk.map(()=>tuple).join(',')})
        INSERT INTO ${table}(${fields.join(',')}) SELECT * FROM input WHERE ${guard}
        ON CONFLICT(id) ${conflict}`).bind(...chunk.flatMap(row=>Object.values(row)),current);
    });
  });
  await db.batch([
    ...writes,
    db.prepare(`DELETE FROM synthetic_demand WHERE id IN (${legacyDemandIds.map(()=>'?').join(',')}) AND ${guard}`).bind(...legacyDemandIds,current),
    db.prepare('UPDATE operations SET demo_version=? WHERE id=1 AND demo_version=?').bind(demoVersion,current),
  ]);
  return demoVersion;
}

export async function printDemoPlan(db) {
  const plan=await demoPlan(db);
  console.log(`Demo fixture v${plan.version} → v${plan.target}`);
  for(const table of Object.keys(plan.counts)) console.log(`  ${table}: ${plan.current[table]} current → ${plan.counts[table]} planned`);
  console.log(plan.version>=plan.target?'The current fixture is already installed.':'Fixture records only. Manual inventory, real requests and accounts are preserved.');
  return plan;
}

export async function createOperatorAccount(db,env,{email,password,name,role,purpose}) {
  const auth=createAuth({DB:db,...env});
  return auth.api.createUser({body:{email,password,name,role,data:purpose?{purpose}:undefined}});
}

export async function localAccounts(db,env,dir) {
  const path=join(dir,'demo-accounts.json');
  let accounts;
  if(existsSync(path)) accounts=JSON.parse(readFileSync(path,'utf8'));
  else {
    const credential=role=>({email:`${role}@blockfit.example`,password:randomBytes(24).toString('base64url'),
      name:role==='staff'?'Demo staff':'Demo resident',role});
    accounts={staff:credential('staff'),resident:credential('resident')};
    writeFileSync(path,JSON.stringify(accounts,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  for(const account of Object.values(accounts)) {
    const stored=await db.prepare('SELECT role FROM user WHERE email=?').bind(account.email).first();
    if (!stored) await createOperatorAccount(db,env,{...account,purpose:'presentation'});
    else if (stored.role!==account.role) throw new Error('A local demo login is already assigned to another role.');
  }
  return accounts;
}
