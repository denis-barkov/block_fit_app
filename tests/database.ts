import { readFileSync } from 'node:fs';
import { getPlatformProxy,unstable_splitSqlQuery } from 'wrangler';

export async function database() {
  const proxy=await getPlatformProxy<{DB:D1Database}>({configPath:'wrangler.jsonc',persist:false,remoteBindings:false,envFiles:[]});
  for (const name of ['0001_schema','0002_pilot_operations']) {
    const sql=readFileSync(`migrations/${name}.sql`,'utf8');
    await proxy.env.DB.batch(unstable_splitSqlQuery(sql).map(query=>proxy.env.DB.prepare(query)));
  }
  return proxy;
}
