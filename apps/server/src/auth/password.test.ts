import { describe, expect, it } from 'vitest';

import { hashPassword, newToken, PASSWORD_HASH_ITERATIONS, verifyPassword } from './password.ts';

// A low count keeps the suite fast; the stored record carries its own count,
// so verification follows whatever the hash was made with.
const FAST = 1_000;

describe('password hashing', () => {
  it('accepts the password it was made from and refuses any other', async () => {
    const stored = await hashPassword('correct horse', FAST);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('correct hors', stored)).toBe(false);
    expect(await verifyPassword('Correct horse', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash, so the same password never stores the same way twice', async () => {
    const a = await hashPassword('same', FAST);
    const b = await hashPassword('same', FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('never stores the password itself', async () => {
    const stored = await hashPassword('plain-text-check', FAST);
    expect(JSON.stringify(stored)).not.toContain('plain-text-check');
  });

  it('defaults to the most PBKDF2 iterations the Workers runtime allows', async () => {
    expect(PASSWORD_HASH_ITERATIONS).toBe(100_000);
    const stored = await hashPassword('default count');
    expect(stored.iterations).toBe(100_000);
    expect(await verifyPassword('default count', stored)).toBe(true);
  });
});

describe('newToken', () => {
  it('is 32 random bytes as base64url, different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, newToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
