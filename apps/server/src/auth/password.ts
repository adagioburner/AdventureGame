/**
 * Password hashing and login tokens for the v1 username-and-password
 * `AuthProvider` (§6.1). Nothing outside `apps/server/src/auth` sees a password
 * or a hash, which is what lets a stronger method replace this one later
 * without a rewrite.
 *
 * PBKDF2 with SHA-256 through WebCrypto, because that is what the Workers
 * runtime offers natively; it caps PBKDF2 at 100,000 iterations, so that is the
 * count. Each password gets its own random salt, and the stored record names
 * its algorithm and count so either can change later without invalidating the
 * accounts made before.
 */

export const PASSWORD_HASH_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const TOKEN_BYTES = 32;

export interface PasswordHash {
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  /** base64url */
  readonly salt: string;
  /** base64url */
  readonly hash: string;
}

export async function hashPassword(password: string, iterations = PASSWORD_HASH_ITERATIONS): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { algorithm: 'pbkdf2-sha256', iterations, salt: toBase64Url(salt), hash: toBase64Url(hash) };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const hash = await derive(password, fromBase64Url(stored.salt), stored.iterations);
  return constantTimeEqual(hash, fromBase64Url(stored.hash));
}

/** An unguessable bearer token: 32 random bytes, base64url. */
export function newToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
