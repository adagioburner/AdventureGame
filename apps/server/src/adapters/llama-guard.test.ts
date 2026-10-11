import { describe, expect, it } from 'vitest';

import { LLAMA_GUARD_MODEL, llamaGuardCheck, verdictOf, type LlamaGuardOutput, type LlamaGuardRunner } from './llama-guard.ts';

function runner(answer: () => Promise<LlamaGuardOutput>): LlamaGuardRunner & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    run: (model, input) => {
      calls.push({ model, input });
      return answer();
    },
  };
}

describe('verdictOf (Q300, 3)', () => {
  it('reads the JSON answer', () => {
    expect(verdictOf({ response: { safe: true } })).toBe('safe');
    expect(verdictOf({ response: { safe: false, categories: ['S10'] } })).toBe('flagged');
  });

  it('reads the model’s own text, and JSON sent as text', () => {
    expect(verdictOf({ response: 'safe' })).toBe('safe');
    expect(verdictOf({ response: '\n\nunsafe\nS10' })).toBe('flagged');
    expect(verdictOf({ response: '{"safe": false, "categories": ["S12"]}' })).toBe('flagged');
    expect(verdictOf({ response: '{"safe": true}' })).toBe('safe');
  });

  it('takes anything else for no answer at all', () => {
    expect(verdictOf({})).toBe('unchecked');
    expect(verdictOf({ response: {} })).toBe('unchecked');
    expect(verdictOf({ response: 'I cannot help with that' })).toBe('unchecked');
  });
});

describe('llamaGuardCheck (Q300, 3 and 4)', () => {
  it('sends the post as the one user message, asking for JSON', async () => {
    const ai = runner(async () => ({ response: { safe: true } }));
    expect(await llamaGuardCheck(ai)('Hello, everyone')).toBe('safe');
    expect(ai.calls).toEqual([
      {
        model: LLAMA_GUARD_MODEL,
        input: { messages: [{ role: 'user', content: 'Hello, everyone' }], response_format: { type: 'json_object' } },
      },
    ]);
  });

  it('is unchecked when Workers AI fails, as it does past the day’s free neurons', async () => {
    const ai = runner(async () => {
      throw new Error('out of free neurons for today');
    });
    expect(await llamaGuardCheck(ai)('Hello')).toBe('unchecked');
  });

  it('is unchecked when no answer comes in time', async () => {
    const ai = runner(() => new Promise(() => undefined));
    expect(await llamaGuardCheck(ai, 20)('Hello')).toBe('unchecked');
  });
});
