import {performance} from 'node:perf_hooks';
import {createAuth} from '../src/server/auth.ts';
import {environment} from './environment.mjs';

const env=environment('local');
const {password}=await createAuth({
  APP_ORIGIN:env.APP_ORIGIN,AUTH_SECRET:env.AUTH_SECRET,
}).$context;
const input='Isolated synthetic passphrase for performance measurement';
const hash=await password.hash(input);
const results=[];
for(let index=0;index<7;index++) {
  const start=performance.now();
  const cpu=process.cpuUsage();
  if(!await password.verify({hash,password:input}))throw new Error('Password verification failed.');
  const used=process.cpuUsage(cpu);
  results.push({wall:performance.now()-start,cpu:(used.user+used.system)/1000});
}
const median=key=>results.map(value=>value[key]).sort((a,b)=>a-b)[3].toFixed(1);
console.log(`Better Auth password verification (Node host median): ${median('wall')} ms wall, ${median('cpu')} ms process CPU.`);
