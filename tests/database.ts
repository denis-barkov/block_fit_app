import { readFileSync,readdirSync } from 'node:fs';
import { getPlatformProxy,unstable_splitSqlQuery } from 'wrangler';

export async function database(latest=true) {
  const proxy=await getPlatformProxy<{DB:D1Database}>({configPath:'wrangler.jsonc',persist:false,remoteBindings:false,envFiles:[]});
  const files=readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort();
  for (const name of latest?files:files.slice(0,2)) {
    const sql=readFileSync(`migrations/${name}`,'utf8');
    await proxy.env.DB.batch(unstable_splitSqlQuery(sql).map(query=>proxy.env.DB.prepare(query)));
  }
  return proxy;
}
