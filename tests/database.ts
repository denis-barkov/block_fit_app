import { readFileSync,readdirSync } from 'node:fs';
import { getPlatformProxy,unstable_splitSqlQuery } from 'wrangler';

export async function applyMigrations(db:D1Database,from=0,to?:number) {
  const files=readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort();
  for (const name of files.slice(from,to)) {
    const sql=readFileSync(`migrations/${name}`,'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(query=>db.prepare(query)));
  }
}
export async function database(latest:boolean|number=true) {
  const proxy=await getPlatformProxy<{DB:D1Database}>({configPath:'wrangler.jsonc',persist:false,remoteBindings:false,envFiles:[]});
  await applyMigrations(proxy.env.DB,0,typeof latest==='number'?latest:latest?undefined:2);
  return proxy;
}
