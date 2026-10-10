import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { asUserId } from '@adventure/core';
import { createSqlAccountFlags, createSqlAccountStore, type SqlLike } from '../src/adapters/durable-object.ts';
import type { AccountRecord } from '../src/auth/accounts.ts';
import { createSqlSiteBoardStore } from '../src/board.ts';

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

describe('createSqlAccountFlags (Q300, 6 and 7)', () => {
  it('adds both flags, off, to an accounts table made before them, keeping its accounts', async () => {
    const sql = nodeSql();
    const accounts = createSqlAccountStore(sql);
    await accounts.insertAccount(account('u1', 'Andrei'));
    await accounts.insertAccount(account('u2', 'Bea'));
    const flags = createSqlAccountFlags(sql);
    expect(flags.flagsOf(asUserId('u1'))).toEqual({ moderator: false, postingBlocked: false });
    expect(await accounts.accountByKey('andrei')).toEqual(account('u1', 'Andrei'));
    // Opened again, as each time the lobby wakes.
    createSqlAccountFlags(sql);
    expect(flags.flagsOf(asUserId('u2'))).toEqual({ moderator: false, postingBlocked: false });
  });

  it('gives the moderator flag by username key, and stops and lets accounts post', async () => {
    const sql = nodeSql();
    const accounts = createSqlAccountStore(sql);
    await accounts.insertAccount(account('u1', 'Andrei'));
    await accounts.insertAccount(account('u2', 'Bea'));
    const flags = createSqlAccountFlags(sql);
    flags.grantModerator('andrei');
    flags.grantModerator('nobody');
    expect(flags.flagsOf(asUserId('u1')).moderator).toBe(true);
    expect(flags.flagsOf(asUserId('u2')).moderator).toBe(false);

    expect(flags.setPostingBlocked(asUserId('u2'), true)).toBe(true);
    expect(flags.setPostingBlocked(asUserId('u9'), true)).toBe(false);
    expect(flags.flagsOf(asUserId('u2')).postingBlocked).toBe(true);
    expect(flags.blockedAccounts()).toEqual(['u2']);
    flags.setPostingBlocked(asUserId('u2'), false);
    expect(flags.blockedAccounts()).toEqual([]);
    expect(flags.flagsOf(asUserId('u9'))).toEqual({ moderator: false, postingBlocked: false });
  });
});

describe('createSqlSiteBoardStore (Q300)', () => {
  it('keeps posts in the order they came, and a deleted one in its place without its words', () => {
    const sql = nodeSql();
    const board = createSqlSiteBoardStore(sql);
    board.add({ id: 'b', author: asUserId('u2'), authorName: 'Bea', body: 'first', postedAt: 20 });
    board.add({ id: 'a', author: asUserId('u3'), authorName: 'Cal', body: 'second', postedAt: 10 });
    board.erase('b');
    expect(createSqlSiteBoardStore(sql).all()).toEqual([
      { id: 'b', author: 'u2', authorName: 'Bea', body: '', postedAt: 20, deleted: true },
      { id: 'a', author: 'u3', authorName: 'Cal', body: 'second', postedAt: 10 },
    ]);
  });

  it('removes the posts put on the board before a time, deleted or not (13)', () => {
    const board = createSqlSiteBoardStore(nodeSql());
    board.add({ id: 'a', author: asUserId('u2'), authorName: 'Bea', body: 'old', postedAt: 10 });
    board.add({ id: 'b', author: asUserId('u2'), authorName: 'Bea', body: 'gone', postedAt: 15 });
    board.add({ id: 'c', author: asUserId('u3'), authorName: 'Cal', body: 'new', postedAt: 20 });
    board.erase('b');
    board.removePostedBefore(20);
    expect(board.all().map((post) => post.id)).toEqual(['c']);
  });
});
