import { defineConfig } from '@playwright/test';

const origin=process.env.BLOCKFIT_BROWSER_ORIGIN||'http://127.0.0.1:8787';
export default defineConfig({
  testDir:'tests/browser',
  workers:1,
  timeout:40_000,
  use:{baseURL:origin,browserName:'chromium',viewport:{width:1440,height:1000},acceptDownloads:true,
    screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'node scripts/browser.mjs serve',url:origin+'/api/health',timeout:120_000,
    gracefulShutdown:{signal:'SIGTERM',timeout:5000},reuseExistingServer:false},
});
