import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { asUserId } from '@adventure/core';
import { createSqlAccountStore, type SqlLike } from '../src/adapters/durable-object.ts';
import type { AccountRecord } from '../src/auth/accounts.ts';

/** Node's SQLite standing in for a Durable Object's `storage.sql`. */
function nodeSql(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Record<string, string | number | null>[];
      return { toArray: () => rows };
    },
  };
}

const account = (userId: string, username: string): AccountRecord => ({
  userId: asUserId(userId),
  username,
  key: username.toLowerCase(),
  password: { algorithm: 'pbkdf2-sha256', iterations: 1, salt: 'c2FsdA', hash: 'aGFzaA' },
  createdAt: 5,
});

describe('createSqlAccountStore', () => {
  it('stores an account once per key and finds it by key and by id', async () => {
    const store = createSqlAccountStore(nodeSql());
    expect(await store.insertAccount(account('u1', 'Andrei'))).toBe(true);
    expect(await store.insertAccount(account('u2', 'ANDREI'))).toBe(false);
    expect(await store.accountByKey('andrei')).toEqual(account('u1', 'Andrei'));
    expect(await store.accountById(asUserId('u1'))).toEqual(account('u1', 'Andrei'));
    expect(await store.accountById(asUserId('u2'))).toBeNull();
  });

  it('keeps logins until deleted, with or without an end', async () => {
    const store = createSqlAccountStore(nodeSql());
    await store.insertLogin({ tokenHash: 't1', userId: asUserId('u1'), expiresAt: 100 });
    await store.insertLogin({ tokenHash: 't2', userId: asUserId('u1'), expiresAt: null });
    expect(await store.loginByTokenHash('t1')).toEqual({ tokenHash: 't1', userId: 'u1', expiresAt: 100 });
    expect(await store.loginByTokenHash('t2')).toEqual({ tokenHash: 't2', userId: 'u1', expiresAt: null });
    await store.deleteLogin('t1');
    expect(await store.loginByTokenHash('t1')).toBeNull();
    expect(await store.loginByTokenHash('t2')).not.toBeNull();
  });

  it('opens an existing database without losing what it holds', async () => {
    const sql = nodeSql();
    await createSqlAccountStore(sql).insertAccount(account('u1', 'Andrei'));
    expect(await createSqlAccountStore(sql).accountByKey('andrei')).not.toBeNull();
  });
});
