import explainInvestmentOptions from '../../prompts/investment-comparison/explain-investment-options.txt';

type PromptValues = Readonly<Record<string, string | number>>;

export function renderPrompt(template: string, keys: readonly string[], values: PromptValues = {}) {
  const expected = new Set(keys);
  for (const [key,value] of Object.entries(values)) {
    if (!expected.has(key) || (typeof value !== 'string' && !Number.isFinite(value))) {
      throw new Error('Unsupported prompt value.');
    }
  }

  const referenced = new Set<string>();
  const rendered = template.replace(/\{\{([a-z][a-z0-9_]*)\}\}(?!\})|\{\{|\}\}/g, (_,key?: string) => {
    if (!key || !expected.has(key) || !Object.hasOwn(values,key)) throw new Error('Invalid prompt token.');
    referenced.add(key);
    return String(values[key]);
  });
  if (referenced.size !== expected.size) throw new Error('Missing prompt token.');
  return rendered;
}

export function loadPrompt(id: string, values: PromptValues) {
  if (id !== 'explain-investment-options') throw new Error('Unknown prompt.');
  if (!Number.isSafeInteger(values.output_word_limit) || Number(values.output_word_limit) <= 0) {
    throw new Error('Invalid output word limit.');
  }
  return renderPrompt(explainInvestmentOptions,['output_word_limit'],values);
}
