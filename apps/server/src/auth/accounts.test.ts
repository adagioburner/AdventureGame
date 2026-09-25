import { describe, expect, it } from 'vitest';

import { asUserId } from '@adventure/core';
import type { AuthToken } from '@adventure/protocol';
import { createMemoryAccountStore } from '../adapters/memory.ts';
import { AccountError, PasswordAccounts, type AccountRules } from './accounts.ts';

/**
 * Rules for these tests only. The real ones are Andrei's answers to phase 6
 * open details 2 to 4; these are picked to exercise each hook, not to propose
 * values.
 */
const TEST_RULES: AccountRules = {
  canonicalUsername: (name) => name.toLowerCase(),
  usernameProblem: (name) => (name.startsWith('bad') ? 'bad name' : null),
  passwordProblem: (password) => (password.length < 3 ? 'too short' : null),
  loginLifetimeMs: 1_000,
};

function setup(rules: AccountRules = TEST_RULES) {
  let now = 0;
  let ids = 0;
  const clock = { now: () => now };
  const accounts = new PasswordAccounts(createMemoryAccountStore(), rules, clock, () => asUserId(`u${++ids}`));
  return { accounts, advance: (ms: number) => (now += ms) };
}

describe('PasswordAccounts', () => {
  it('registers, and the token it returns identifies the new account', async () => {
    const { accounts } = setup();
    const { principal, token } = await accounts.register({ method: 'password', username: 'Andrei', password: 'secret' });
    expect(principal).toEqual({ userId: 'u1', displayName: 'Andrei' });
    expect(await accounts.verify(token)).toEqual(principal);
  });

  it('logs in with the right password only, with one message for a wrong password or an unknown name', async () => {
    const { accounts } = setup();
    await accounts.register({ method: 'password', username: 'Andrei', password: 'secret' });

    const result = await accounts.authenticate({ method: 'password', username: 'Andrei', password: 'secret' });
    expect(result.principal.userId).toBe('u1');

    const wrong = await accounts.authenticate({ method: 'password', username: 'Andrei', password: 'nope' }).catch((e) => e);
    const unknown = await accounts.authenticate({ method: 'password', username: 'Nobody', password: 'secret' }).catch((e) => e);
    expect(wrong).toBeInstanceOf(AccountError);
    expect(unknown).toBeInstanceOf(AccountError);
    expect(wrong.message).toBe(unknown.message);
  });

  it('keys accounts on the rules’ canonical name', async () => {
    const { accounts } = setup();
    await accounts.register({ method: 'password', username: 'Andrei', password: 'secret' });
    await expect(accounts.register({ method: 'password', username: 'ANDREI', password: 'other' })).rejects.toMatchObject({
      reason: 'username_taken',
    });
    const result = await accounts.authenticate({ method: 'password', username: 'andrei', password: 'secret' });
    expect(result.principal.displayName).toBe('Andrei');
  });

  it('refuses what the rules refuse, with the rules’ reason', async () => {
    const { accounts } = setup();
    await expect(accounts.register({ method: 'password', username: 'badname', password: 'secret' })).rejects.toMatchObject({
      reason: 'username_invalid',
      message: 'bad name',
    });
    await expect(accounts.register({ method: 'password', username: 'fine', password: 'no' })).rejects.toMatchObject({
      reason: 'password_invalid',
      message: 'too short',
    });
  });

  it('ends a login when its lifetime runs out, and on log out', async () => {
    const { accounts, advance } = setup();
    const first = await accounts.register({ method: 'password', username: 'Andrei', password: 'secret' });
    advance(999);
    expect(await accounts.verify(first.token)).not.toBeNull();
    advance(1);
    expect(await accounts.verify(first.token)).toBeNull();

    const second = await accounts.authenticate({ method: 'password', username: 'Andrei', password: 'secret' });
    await accounts.logOut(second.token);
    expect(await accounts.verify(second.token)).toBeNull();
  });

  it('keeps a login until log out when the rules give it no lifetime', async () => {
    const { accounts, advance } = setup({ ...TEST_RULES, loginLifetimeMs: null });
    const { token } = await accounts.register({ method: 'password', username: 'Andrei', password: 'secret' });
    advance(10 ** 12);
    expect(await accounts.verify(token)).not.toBeNull();
  });

  it('knows no token it did not issue', async () => {
    const { accounts } = setup();
    expect(await accounts.verify('made-up' as AuthToken)).toBeNull();
  });
});
