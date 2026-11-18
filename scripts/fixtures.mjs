import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {createAuth} from '../src/server/auth.ts';
import {categories} from '../config/settings.ts';

const amount=(base)=>({low:Math.round(base*.8),base,high:Math.round(base*1.2)});
const profile=(equipment,installation,maintenance)=>JSON.stringify({
  equipment:amount(equipment),installation:amount(installation),preparation:amount(0),accessibility:amount(0),
  maintenance:amount(maintenance),replacement:amount(300_000),interval:8,replacementPlan:'scheduled',
  source:'Illustrative costs for the Forest Hills demo',
});
export async function seedDataset(db) {
  const park = db.prepare(`INSERT INTO parks(id,name,lat,lng,external_id,source,hours) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const equip = db.prepare(`INSERT INTO equipment(id,name,category,lat,lng,park_id,condition,access,source,verified_on,visible)
    VALUES(?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING`);
  const candidate = db.prepare(`INSERT INTO candidates(id,name,category,lat,lng,park_id,feasibility,costs,notes,project_url)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const demand = db.prepare('INSERT INTO synthetic_demand(id,category,lat,lng) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING');
  const sample='Illustrative pilot fixture. No site inspection.';
  await db.batch([
    park.bind('demo-west','Forest Hills West (demo area)',40.7190,-73.8500,'',sample,''),
    park.bind('demo-east','Forest Hills East (demo area)',40.7180,-73.8415,'',sample,''),
    equip.bind('demo-bars','West court pull-up bars','pull-up',40.7190,-73.8500,'demo-west','usable','public',
      'Synthetic fixture marked verified for baseline demonstration','2026-11-17'),
    equip.bind('demo-parallel','East court parallel bars','parallel',40.7180,-73.8415,'demo-east','unknown','unknown',sample,null),
    equip.bind('demo-bench','Standalone sit-up bench','sit-up',40.7179,-73.8450,null,'unknown','unknown',sample,null),
    candidate.bind('demo-a','Central courtyard A','pull-up',40.7190,-73.8465,null,'suitable-for-comparison',
      profile(700_000,500_000,40_000),'Illustrative candidate. Confirm site preparation and accessibility with field staff.',null),
    candidate.bind('demo-b','Central courtyard B','pull-up',40.7190,-73.8435,null,'suitable-for-comparison',
      profile(900_000,600_000,50_000),'Illustrative candidate. Confirm ownership and site conditions.',null),
    candidate.bind('demo-c','East exercise station','parallel',40.7179,-73.8415,'demo-east','unreviewed',
      profile(650_000,520_000,42_000),'Illustrative candidate with feasibility pending.',null),
    ...Array.from({length:25},(_,index)=>demand.bind(`demo-demand-${index}`,
      Object.keys(categories)[index<17?0:index<22?1:2],
      40.7190+((index%5)-2)*.00038,-73.8500+(index%17)*.00050)),
  ]);
}

export async function createOperatorAccount(db,env,{email,password,name,role}) {
  const auth=createAuth({DB:db,...env});
  return auth.api.createUser({body:{email,password,name,role}});
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
    if (!stored) await createOperatorAccount(db,env,account);
    else if (stored.role!==account.role) throw new Error('A local demo login is already assigned to another role.');
  }
  return accounts;
}
