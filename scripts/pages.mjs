import {copyFileSync,cpSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {bin,run} from './environment.mjs';
import {CloudflareError} from './cloudflare.mjs';
import {appTitleHTML,brandHead} from '../src/html.ts';
import {brandAssets} from '../config/app.ts';
import {browserHeaders} from '../src/pages/_worker.js';

export const pagesBranch='main';
export const pagesProjectPath=env=>'/pages/projects/'+env.PAGES_PROJECT_NAME;

export async function findPagesProject(call,env) {
  const path=pagesProjectPath(env);
  try {return await call(path);}
  catch(error) {
    if(error instanceof CloudflareError && error.status===404) return null;
    throw error;
  }
}

export function verifiedPages(env,record,project) {
  if(!project || project.id!==record.pagesId || project.name!==record.pagesName ||
      project.name!==env.PAGES_PROJECT_NAME || project.production_branch!==pagesBranch) {
    throw new Error('The Pages project does not match the protected deployment manifest.');
  }
  const origin=new URL('https://'+project.subdomain);
  if(!/^[a-z0-9][a-z0-9-]*\.pages\.dev$/.test(project.subdomain) ||
      (env.APP_ORIGIN && env.APP_ORIGIN!==origin.origin)) {
    throw new Error('The Pages project does not have the expected canonical pages.dev origin.');
  }
  return {...env,APP_ORIGIN:origin.origin,origin};
}

export function scanPublicAssets(directory,env) {
  const privateValues=[resolve('.'), env.CLOUDFLARE_ACCOUNT_ID,env.AUTH_SECRET,
    env.OPENAI_API_KEY,env.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_TAG_API_TOKEN,
    env.resourceName+'.',env.databaseId].filter(Boolean);
  for(const entry of readdirSync(directory,{recursive:true,withFileTypes:true})) {
    if(!entry.isFile() || ['_worker.js','_headers','_routes.json'].includes(entry.name))continue;
    const content=readFileSync(join(entry.parentPath,entry.name));
    if(/(?:^\.env|\.map$)/.test(entry.name) ||
        privateValues.some(value=>content.includes(value)) ||
        /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=/.test(content.toString('utf8'))) {
      throw new Error('Unexpected private material or source map in public artifact: '+entry.name);
    }
  }
}

export function packagePages(env,directory) {
  const output=join(directory,'pages');
  const path=join(directory,'wrangler.json');
  // Recreate only the generated stage so removed files cannot survive into the next deployment.
  rmSync(output,{force:true,recursive:true});
  mkdirSync(output,{recursive:true,mode:0o700});
  const {compatibility_date}=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const config={
    name:env.PAGES_PROJECT_NAME, pages_build_output_dir:'./pages', compatibility_date,
    vars:{APP_ORIGIN:env.APP_ORIGIN},
    services:[{binding:'BACKEND',service:env.resourceName}],
  };
  copyFileSync(resolve('src/pages/_worker.js'),join(output,'_worker.js'));
  const staticRoutes=['/assets/*','/brand/*'];
  writeFileSync(join(output,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:staticRoutes})+'\n');
  const headers=Object.entries(browserHeaders).map(([name,value])=>`  ${name}: ${value}`).join('\n');
  writeFileSync(join(output,'_headers'),staticRoutes.map(route=>`${route}\n${headers}\n`).join('\n'));
  cpSync(resolve('dist/brand'),join(output,'brand'),{recursive:true});
  cpSync(resolve('dist/assets'),join(output,'assets'),{recursive:true});
  writeFileSync(join(output,'index.html'),`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${appTitleHTML}</title>
  ${brandHead()}
</head>
<body>
  <main>
    <img src="${brandAssets.mark}" width="64" height="64" alt="">
    <h1>${appTitleHTML}</h1>
    <p>The application is temporarily unavailable.</p>
  </main>
</body>
</html>
`);
  writeFileSync(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  scanPublicAssets(output,env);
  console.log(`Packaged Pages ingress for ${env.APP_ORIGIN}.`);
  return {path,output};
}

export function deployPages(env,{path,output}) {
  run(bin('wrangler'),['pages','deploy',basename(output),'--project-name',env.PAGES_PROJECT_NAME,'--branch',pagesBranch],
    env,{cwd:dirname(path)});
}
