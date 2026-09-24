import { describe, expect, it } from 'vitest';

import { ACCOUNT_RULES } from './rules.ts';

describe('the account rules (Q48, 2 to 4)', () => {
  it('takes 3 to 20 letters, digits or underscores as a username', () => {
    for (const ok of ['Andrei', 'bob', 'x_1', 'A'.repeat(20), 'Андрей', 'Zoë_2']) {
      expect(ACCOUNT_RULES.usernameProblem(ok), ok).toBeNull();
    }
    for (const bad of ['ab', 'A'.repeat(21), 'has space', 'dash-ed', 'dot.ted', '', 'émoji😀']) {
      expect(ACCOUNT_RULES.usernameProblem(bad), bad).not.toBeNull();
    }
  });

  it('treats capitals as the same name', () => {
    expect(ACCOUNT_RULES.canonicalUsername('Andrei')).toBe(ACCOUNT_RULES.canonicalUsername('ANDREI'));
  });

  it('takes a password of at least 8 characters and nothing else', () => {
    expect(ACCOUNT_RULES.passwordProblem('1234567')).not.toBeNull();
    expect(ACCOUNT_RULES.passwordProblem('12345678')).toBeNull();
    expect(ACCOUNT_RULES.passwordProblem('        ')).toBeNull();
  });

  it('keeps a login for 30 days', () => {
    expect(ACCOUNT_RULES.loginLifetimeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
