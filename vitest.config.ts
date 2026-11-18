import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/*.test.{ts,mjs}'],testTimeout:25_000,hookTimeout:25_000}});
