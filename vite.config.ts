import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import { appTitleHTML } from './src/html.ts';

export default defineConfig({
  envDir: false,
  plugins: [tailwind(), {
    name: 'app-title',
    transformIndexHtml: html => html.replace('%APP_NAME%', () => appTitleHTML),
  }],
});
