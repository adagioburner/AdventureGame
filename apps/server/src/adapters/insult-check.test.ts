import { describe, expect, it } from 'vitest';

import { INSULT_INSTRUCTIONS, INSULT_MODEL, insultCheck, verdictOfInsult, type InsultRunner } from './insult-check.ts';

function runner(answer: () => Promise<unknown>): InsultRunner & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    run: (model, input) => {
      calls.push({ model, input });
      return answer();
    },
  };
}

describe('verdictOfInsult (Q300, 5 B)', () => {
  it('flags "offensive" and passes "fine", however the model dresses the word', () => {
    expect(verdictOfInsult({ response: 'offensive' })).toBe('flagged');
    expect(verdictOfInsult({ response: ' "Offensive." ' })).toBe('flagged');
    expect(verdictOfInsult({ response: 'fine' })).toBe('safe');
    expect(verdictOfInsult({ response: 'Fine.\n' })).toBe('safe');
    expect(verdictOfInsult('fine')).toBe('safe');
  });

  it('takes anything else for no answer at all', () => {
    expect(verdictOfInsult({})).toBe('unchecked');
    expect(verdictOfInsult({ request_id: 'queued' })).toBe('unchecked');
    expect(verdictOfInsult({ response: 'It is fine' })).toBe('unchecked');
    expect(verdictOfInsult({ response: '' })).toBe('unchecked');
    expect(verdictOfInsult(null)).toBe('unchecked');
  });
});

describe('insultCheck (Q300, 5 B and 4 A)', () => {
  it('sends the instructions, then the post as the user message, for a one-word answer', async () => {
    const ai = runner(async () => ({ response: 'offensive' }));
    expect(await insultCheck(ai)('You are all idiots')).toBe('flagged');
    expect(ai.calls).toEqual([
      {
        model: INSULT_MODEL,
        input: {
          messages: [
            { role: 'system', content: INSULT_INSTRUCTIONS },
            { role: 'user', content: 'You are all idiots' },
          ],
          max_tokens: 5,
          temperature: 0,
        },
      },
    ]);
  });

  it('asks about slurs and insults, and lets swearing in passing through', () => {
    expect(INSULT_INSTRUCTIONS).toContain('slur');
    expect(INSULT_INSTRUCTIONS).toContain('insults anyone, a person or a group');
    expect(INSULT_INSTRUCTIONS).toContain('Swearing that is not aimed at anyone, like "damn, I lost", is fine.');
  });

  it('is unchecked when Workers AI fails or does not answer in time', async () => {
    const failing = runner(async () => {
      throw new Error('out of free neurons for today');
    });
    expect(await insultCheck(failing)('Hello')).toBe('unchecked');
    const silent = runner(() => new Promise(() => undefined));
    expect(await insultCheck(silent, 20)('Hello')).toBe('unchecked');
  });
});
