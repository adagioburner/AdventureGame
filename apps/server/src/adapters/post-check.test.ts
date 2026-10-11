import { describe, expect, it } from 'vitest';

import { everyCheck, type PostCheck, type PostVerdict } from './post-check.ts';

const answers =
  (verdict: PostVerdict): PostCheck =>
  async () =>
    verdict;

describe('everyCheck (Q300, 3 to 5)', () => {
  it('puts a post up only when every check says it is safe', async () => {
    expect(await everyCheck(answers('safe'), answers('safe'))('Hello')).toBe('safe');
  });

  it('refuses it as offensive when either check flags it, even if the other could not run', async () => {
    expect(await everyCheck(answers('safe'), answers('flagged'))('x')).toBe('flagged');
    expect(await everyCheck(answers('flagged'), answers('safe'))('x')).toBe('flagged');
    expect(await everyCheck(answers('unchecked'), answers('flagged'))('x')).toBe('flagged');
  });

  it('refuses it with "try again later" when neither flags it but one could not run (4 A)', async () => {
    expect(await everyCheck(answers('safe'), answers('unchecked'))('x')).toBe('unchecked');
    expect(await everyCheck(answers('unchecked'), answers('safe'))('x')).toBe('unchecked');
  });

  it('asks every check about the same words, at once', async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const slow: PostCheck = (body) =>
      new Promise((resolve) => {
        seen.push(`slow ${body}`);
        release = () => resolve('safe');
      });
    const quick: PostCheck = async (body) => {
      seen.push(`quick ${body}`);
      return 'safe';
    };
    const verdict = everyCheck(slow, quick)('Hi');
    expect(seen).toEqual(['slow Hi', 'quick Hi']);
    release();
    expect(await verdict).toBe('safe');
  });
});
