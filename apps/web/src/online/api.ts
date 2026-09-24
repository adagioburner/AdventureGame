import type { AuthFailure, LoginResponse, Principal } from '@adventure/protocol';

/**
 * The site's account endpoints (`apps/server/src/worker.ts`) and the login
 * this browser keeps.
 *
 * [Q48, 4] A login lasts 30 days on the browser that made it, so the token is
 * kept in `localStorage`. A browser that refuses storage (a private window, an
 * embedded preview) still logs in; it just asks again next visit.
 */

export type Login = LoginResponse;

const LOGIN_KEY = 'adventure.login';

/** A register or login the server refused, with its sentence for the page. */
export class LoginRefused extends Error {
  override readonly name = 'LoginRefused';
}

export function savedLogin(): Login | null {
  try {
    const text = window.localStorage.getItem(LOGIN_KEY);
    if (text === null) return null;
    const login = JSON.parse(text) as Partial<Login>;
    const user = login.user as Partial<Principal> | undefined;
    return typeof login.token === 'string' && typeof user?.userId === 'string' && typeof user.displayName === 'string'
      ? (login as Login)
      : null;
  } catch {
    return null;
  }
}

export function saveLogin(login: Login | null): void {
  try {
    if (login === null) window.localStorage.removeItem(LOGIN_KEY);
    else window.localStorage.setItem(LOGIN_KEY, JSON.stringify(login));
  } catch {
    // Storage refused: the login lasts until the page closes.
  }
}

export function register(username: string, password: string): Promise<Login> {
  return credentials('/api/register', username, password);
}

export function logIn(username: string, password: string): Promise<Login> {
  return credentials('/api/login', username, password);
}

/** Ends the login on the server too. A failure here still logs the page out. */
export async function logOut(token: string): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // The token is forgotten here either way.
  }
}

/** Who a token belongs to: `null` once the server no longer knows it, and a throw when the server can't be reached. */
export async function whoAmI(token: string): Promise<Principal | null> {
  const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  return (await response.json()) as Principal;
}

/** The address of one of the site's sockets, carrying the login. */
export function socketUrl(path: string, token: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

async function credentials(path: string, username: string, password: string): Promise<Login> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new LoginRefused('The server could not be reached. Check the connection and try again.');
  }
  const body = (await response.json().catch(() => null)) as Login | AuthFailure | null;
  if (response.ok && body !== null && 'token' in body) return body;
  throw new LoginRefused(body !== null && 'error' in body ? body.error : 'Something went wrong on the server.');
}
