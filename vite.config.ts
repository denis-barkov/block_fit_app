import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import { appTitleHTML, brandManifest, publicHead } from './src/html.ts';
import { brandAssets } from './config/app.ts';

export default defineConfig({
  envDir: false,
  plugins: [tailwind(), {
    name: 'app-html',
    transformIndexHtml: html=>html.replace('%APP_NAME%',()=>appTitleHTML)
      .replace('<!-- APP_HEAD -->',()=>publicHead(process.env.BLOCKFIT_PUBLIC_ORIGIN)),
    generateBundle() {
      this.emitFile({type:'asset',fileName:brandAssets.manifest.slice(1),source:brandManifest()});
    },
  }],
});
