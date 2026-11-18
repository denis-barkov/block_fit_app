import {expect,it} from 'vitest';
import {ai} from '../config/settings';
import instructions from '../prompts/investment-comparison/explain-investment-options.txt';
import {loadPrompt,renderPrompt} from '../src/server/prompts';

it('loads the version-controlled prompt and resolves the configured word target',()=>{
  expect(instructions).toContain('{{output_word_limit}}');
  expect(loadPrompt('explain-investment-options',{output_word_limit:ai.outputWords}))
    .toBe(instructions.replace('{{output_word_limit}}',String(ai.outputWords)));
  expect(()=>loadPrompt('../other',{output_word_limit:ai.outputWords})).toThrow();
  expect(()=>loadPrompt('explain-investment-options',{output_word_limit:-1})).toThrow();
});

it('preserves literal multiline values, dollars, quotes, and inserted tokens across repeated replacements',()=>{
  const runtime='\n"$& $20,000" {{other}} {x}';
  expect(renderPrompt('Untouched\nwith {braces}',[])).toBe('Untouched\nwith {braces}');
  expect(renderPrompt('{{name}} {{size}} {{name}}',['name','size'],{name:runtime,size:0}))
    .toBe(runtime+' 0 '+runtime);
});

it('rejects invalid original tokens, missing keys, unexpected keys and non-text values',()=>{
  for (const malformed of ['{{ Name }}','{{name','name}}','{{name}}}','{{{name}}','{{name+1}}','{{}}']) {
    expect(()=>renderPrompt(malformed,['name'],{name:'text'})).toThrow();
  }
  expect(()=>renderPrompt('{{other}}',['name'],{name:'text'})).toThrow();
  expect(()=>renderPrompt('{{name}}',['name'])).toThrow();
  expect(()=>renderPrompt('Missing token',['name'],{name:'text'})).toThrow();
  expect(()=>renderPrompt('{{name}}',['name'],{name:'text',other:'unexpected'})).toThrow();
  for(const invalid of [Infinity,NaN,undefined,null,{},true]) {
    // The renderer also validates values arriving outside the typed call path.
    expect(()=>renderPrompt('{{name}}',['name'],{name:invalid as number})).toThrow();
  }
});
