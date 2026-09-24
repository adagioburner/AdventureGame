import { asUserId, type UserId } from '@adventure/core';
import type { AuthProvider, AuthResult, AuthToken, Credentials, Principal } from '@adventure/protocol';
import type { Clock } from '@adventure/session';
import { hashPassword, newToken, verifyPassword, type PasswordHash } from './password.ts';

/**
 * §6.1's v1 authentication, username and password, as an `AuthProvider`.
 *
 * What a username or password may be, whether capitals make a different name,
 * and how long a login lasts are Andrei's to decide (phase 6 open details 2 to
 * 4), so they arrive as `AccountRules` and this file holds no values for them.
 *
 * Tokens are stored as their SHA-256, so a copy of the store does not hand out
 * logins; the token itself exists only in the browser that holds it.
 */

export interface AccountRules {
  /** What makes two usernames the same account; the store keys on this. */
  canonicalUsername(username: string): string;
  /** Why this username cannot be registered, or `null` if it can. */
  usernameProblem(username: string): string | null;
  /** Why this password cannot be used, or `null` if it can. */
  passwordProblem(password: string): string | null;
  /** How long a login lasts, or `null` for until logout. */
  readonly loginLifetimeMs: number | null;
}

export interface AccountRecord {
  readonly userId: UserId;
  /** As typed at registration; shown to other players. */
  readonly username: string;
  /** `AccountRules.canonicalUsername(username)`; unique. */
  readonly key: string;
  readonly password: PasswordHash;
  readonly createdAt: number;
}

export interface LoginRecord {
  /** SHA-256 of the token, base64url. */
  readonly tokenHash: string;
  readonly userId: UserId;
  readonly expiresAt: number | null;
}

export interface AccountStore {
  accountByKey(key: string): Promise<AccountRecord | null>;
  accountById(userId: UserId): Promise<AccountRecord | null>;
  /** Adds the account unless its `key` is taken; says which happened. */
  insertAccount(account: AccountRecord): Promise<boolean>;
  insertLogin(login: LoginRecord): Promise<void>;
  loginByTokenHash(tokenHash: string): Promise<LoginRecord | null>;
  deleteLogin(tokenHash: string): Promise<void>;
}

/** Why a register or login was refused, in words a player can act on. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly reason: 'username_invalid' | 'password_invalid' | 'username_taken' | 'wrong_credentials',
    message: string,
  ) {
    super(message);
  }
}

export class PasswordAccounts implements AuthProvider {
  readonly method = 'password' as const;

  constructor(
    private readonly store: AccountStore,
    private readonly rules: AccountRules,
    private readonly clock: Clock,
    private readonly newUserId: () => UserId = () => asUserId(crypto.randomUUID()),
  ) {}

  async register(credentials: Credentials): Promise<AuthResult> {
    const { username, password } = credentials;
    const usernameProblem = this.rules.usernameProblem(username);
    if (usernameProblem !== null) throw new AccountError('username_invalid', usernameProblem);
    const passwordProblem = this.rules.passwordProblem(password);
    if (passwordProblem !== null) throw new AccountError('password_invalid', passwordProblem);

    const account: AccountRecord = {
      userId: this.newUserId(),
      username,
      key: this.rules.canonicalUsername(username),
      password: await hashPassword(password),
      createdAt: this.clock.now(),
    };
    if (!(await this.store.insertAccount(account))) {
      throw new AccountError('username_taken', 'That username is taken.');
    }
    return this.logIn(account);
  }

  async authenticate(credentials: Credentials): Promise<AuthResult> {
    const account = await this.store.accountByKey(this.rules.canonicalUsername(credentials.username));
    // One message for both, so a login attempt does not reveal which usernames exist.
    if (account === null || !(await verifyPassword(credentials.password, account.password))) {
      throw new AccountError('wrong_credentials', 'That username and password don’t match an account.');
    }
    return this.logIn(account);
  }

  async verify(token: AuthToken): Promise<Principal | null> {
    const tokenHash = await hashToken(token);
    const login = await this.store.loginByTokenHash(tokenHash);
    if (login === null) return null;
    if (login.expiresAt !== null && login.expiresAt <= this.clock.now()) {
      await this.store.deleteLogin(tokenHash);
      return null;
    }
    const account = await this.store.accountById(login.userId);
    return account === null ? null : principalOf(account);
  }

  async logOut(token: AuthToken): Promise<void> {
    await this.store.deleteLogin(await hashToken(token));
  }

  private async logIn(account: AccountRecord): Promise<AuthResult> {
    const token = newToken() as AuthToken;
    const lifetime = this.rules.loginLifetimeMs;
    await this.store.insertLogin({
      tokenHash: await hashToken(token),
      userId: account.userId,
      expiresAt: lifetime === null ? null : this.clock.now() + lifetime,
    });
    return { principal: principalOf(account), token };
  }
}

function principalOf(account: AccountRecord): Principal {
  return { userId: account.userId, displayName: account.username };
}

async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
