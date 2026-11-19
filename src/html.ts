import {readFileSync} from 'node:fs';
import {appIdentity,brandAssets} from '../config/app.ts';

const tokens=readFileSync(new URL('../design/tokens.css',import.meta.url),'utf8');
export function designColor(token:'brand'|'brand-dark'|'paper'|'mint') {
  const value=tokens.match(new RegExp(`--color-${token}:\\s*(#[0-9a-f]{3,8});`,'i'))?.[1];
  if(!value)throw new Error(`Missing color token ${token}.`);
  return value;
}
export const escapeHTML=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;');
export const appTitleHTML=escapeHTML(appIdentity.name);
const iconSize=(size:number)=>`${size}x${size}`;

export function brandHead() {
  return [
    `<meta name="theme-color" content="${designColor('brand')}">`,
    `<meta name="application-name" content="${appTitleHTML}">`,
    `<meta name="apple-mobile-web-app-title" content="${appTitleHTML}">`,
    `<link rel="icon" href="${brandAssets.favicon}" sizes="16x16 32x32">`,
    `<link rel="icon" href="${brandAssets.mark}" type="image/svg+xml" sizes="any">`,
    `<link rel="apple-touch-icon" href="${brandAssets.apple.src}" sizes="${iconSize(brandAssets.apple.size)}">`,
    `<link rel="manifest" href="${brandAssets.manifest}">`,
  ].join('\n  ');
}

export function publicHead(origin?:string) {
  const meta=[brandHead(),`<meta name="description" content="${escapeHTML(appIdentity.description)}">`];
  if(!origin)return meta.join('\n  ');
  const url=new URL('/',origin).href;
  const image=new URL(brandAssets.preview.src,url).href;
  const imageAlt=`${appIdentity.name} green ${appIdentity.monogram} monogram`;
  for(const [key,value] of Object.entries({
    type:'website',site_name:appIdentity.name,title:appIdentity.name,description:appIdentity.description,
    url,image,'image:type':'image/png','image:width':brandAssets.preview.width,
    'image:height':brandAssets.preview.height,'image:alt':imageAlt,
  }))meta.push(`<meta property="og:${key}" content="${escapeHTML(String(value))}">`);
  meta.push('<meta name="twitter:card" content="summary_large_image">');
  return meta.join('\n  ');
}

export function brandManifest() {
  return JSON.stringify({
    id:'/',name:appIdentity.name,short_name:appIdentity.monogram,description:appIdentity.description,
    start_url:'/',scope:'/',display:'standalone',theme_color:designColor('brand'),background_color:designColor('paper'),
    icons:brandAssets.android.map(({src,size,purpose})=>({src,sizes:iconSize(size),purpose,type:'image/png'})),
  },null,2)+'\n';
}
