import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {bin,run} from './environment.mjs';
import {CloudflareError} from './cloudflare.mjs';

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

export function packagePages(env,directory) {
  const output=join(directory,'pages');
  const path=join(directory,'pages.wrangler.json');
  mkdirSync(output,{recursive:true,mode:0o700});
  const {compatibility_date}=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const config={
    name:env.PAGES_PROJECT_NAME, pages_build_output_dir:'./pages', compatibility_date,
    vars:{APP_ORIGIN:env.APP_ORIGIN},
    services:[{binding:'BACKEND',service:env.resourceName}],
  };
  copyFileSync(resolve('src/pages/_worker.js'),join(output,'_worker.js'));
  writeFileSync(join(output,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]})+'\n');
  // A generic static fallback keeps the upload nonempty and contains no app assets or backend information.
  writeFileSync(join(output,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><title>BlockFit NYC</title><p>The application is temporarily unavailable.</p></html>\n');
  writeFileSync(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  console.log(`Packaged Pages ingress for ${env.APP_ORIGIN}.`);
  return {path,output};
}

export function deployPages(env,directory) {
  const {path,output}=packagePages(env,directory);
  run(bin('wrangler'),['pages','deploy',output,'--config',path,'--project-name',env.PAGES_PROJECT_NAME,'--branch',pagesBranch],env);
}
