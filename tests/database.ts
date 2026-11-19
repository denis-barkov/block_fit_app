import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy,unstable_splitSqlQuery } from 'wrangler';

export async function applyMigrations(db:D1Database,from=0,to?:number) {
  const files=readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort();
  for (const name of files.slice(from,to)) {
    const sql=readFileSync(`migrations/${name}`,'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(query=>db.prepare(query)));
  }
}
export async function database(latest:boolean|number=true) {
  const {name,compatibility_date,compatibility_flags,d1_databases}=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const directory=mkdtempSync(join(tmpdir(),'blockfit-d1-test-'));
  const configPath=join(directory,'wrangler.json');
  // The Pages packaging test rebuilds dist concurrently. D1-only tests do not need those assets.
  try {
    writeFileSync(configPath,JSON.stringify({name,compatibility_date,compatibility_flags,d1_databases}));
    const proxy=await getPlatformProxy<{DB:D1Database}>({configPath,persist:false,remoteBindings:false,envFiles:[]});
    try {
      await applyMigrations(proxy.env.DB,0,typeof latest==='number'?latest:latest?undefined:2);
      return proxy;
    } catch(error) {
      await proxy.dispose();
      throw error;
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
}
