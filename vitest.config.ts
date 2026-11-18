import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins:[{
    name:'worker-prompt-text',
    enforce:'pre',
    load(id) {
      if (id.includes('/prompts/') && id.endsWith('.txt')) {
        return `export default ${JSON.stringify(readFileSync(id,'utf8'))};`;
      }
    },
  }],
  test:{include:['tests/*.test.{ts,mjs}'],testTimeout:25_000,hookTimeout:25_000},
});
