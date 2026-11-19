import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {appIdentity,brandAssets} from '../config/app.ts';
import {designColor,escapeHTML} from '../src/html.ts';

const monogram=readFileSync(new URL('../design/brand-monogram.svg',import.meta.url),'utf8').replace(/<\/?svg[^>]*>/g,'').trim();
const green=designColor('brand');
const dark=designColor('brand-dark');
const paper=designColor('paper');
const mint=designColor('mint');
const mark=(bleed=false)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${bleed?0:12}" fill="${green}"/>
  <g${bleed?' transform="translate(5.76 5.76) scale(.82)"':''}>${monogram}</g>
</svg>\n`;

function raster(svg,width,height=width) {
  const result=spawnSync('rsvg-convert',['--width',String(width),'--height',String(height)],{input:svg});
  if(result.error?.code==='ENOENT')throw new Error('Install librsvg to regenerate the brand images.');
  if(result.status!==0)throw new Error(result.stderr?.toString()||'Brand image rendering failed.');
  return result.stdout;
}

const write=(path,content)=>writeFileSync(join('public',path),content);
mkdirSync('public/brand',{recursive:true});
write(brandAssets.mark,mark());
const maskable=mark(true);
writeFileSync('design/brand-maskable.svg',maskable);
write(brandAssets.apple.src,raster(maskable,brandAssets.apple.size));
for(const {src,size,purpose} of brandAssets.android)write(src,raster(purpose==='maskable'?maskable:mark(),size));

const sizes=[16,32];
const images=sizes.map(size=>raster(mark(),size));
const directory=Buffer.alloc(6+16*images.length);
directory.writeUInt16LE(1,2);
directory.writeUInt16LE(images.length,4);
let offset=directory.length;
for(const [index,image] of images.entries()) {
  const entry=6+16*index;
  directory[entry]=directory[entry+1]=sizes[index];
  directory.writeUInt16LE(1,entry+4);
  directory.writeUInt16LE(32,entry+6);
  directory.writeUInt32LE(image.length,entry+8);
  directory.writeUInt32LE(offset,entry+12);
  offset+=image.length;
}
write(brandAssets.favicon,Buffer.concat([directory,...images]));

const {width,height}=brandAssets.preview;
const social=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${dark}"/>
  <circle cx="1120" cy="318" r="330" fill="${green}"/>
  <circle cx="1120" cy="318" r="256" fill="none" stroke="${mint}" stroke-opacity=".30" stroke-width="2"/>
  <circle cx="1120" cy="318" r="206" fill="none" stroke="${mint}" stroke-opacity=".25" stroke-width="2"/>
  <g transform="translate(100 120) scale(2.15)">
    <rect width="64" height="64" rx="12" fill="${green}" stroke="${mint}" stroke-opacity=".55" stroke-width="1"/>
    ${monogram}
  </g>
  <text x="100" y="387" fill="${paper}" font-family="sans-serif" font-size="88" font-weight="700">${escapeHTML(appIdentity.name)}</text>
  <text x="104" y="463" fill="${mint}" font-family="sans-serif" font-size="32">${escapeHTML(appIdentity.tagline)}</text>
</svg>\n`;
writeFileSync('design/brand-preview.svg',social);
write(brandAssets.preview.src,raster(social,width,height));
