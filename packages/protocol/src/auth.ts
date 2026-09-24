import type { UserId } from '@adventure/core';

/**
 * [SOURCE §3, chat] "v1 authentication: username + password. **Architecture
 * requirement:** design the auth layer so stronger security can be swapped in
 * later without a rewrite."
 *
 * That requirement is met by keeping *everything* behind this port: no other
 * package knows what a password is. `UsernamePasswordCredentials` is one
 * variant of an open union, so adding OAuth, a magic link, WebAuthn or an
 * identity provider later means a new variant and a new adapter — no change to
 * the session layer, the lobby, or any message type below.
 */
export interface UsernamePasswordCredentials {
  readonly method: 'password';
  readonly username: string;
  readonly password: string;
}

/** Widen this union when a second method is added; nothing else changes. */
export type Credentials = UsernamePasswordCredentials;

/** An authenticated identity. Deliberately carries no credential material. */
export interface Principal {
  readonly userId: UserId;
  readonly displayName: string;
}

/** An opaque bearer token. Its format is the adapter's business, not the app's. */
export type AuthToken = string & { readonly __authToken: true };

export interface AuthResult {
  readonly principal: Principal;
  readonly token: AuthToken;
}

export interface AuthProvider {
  readonly method: Credentials['method'];
  authenticate(credentials: Credentials): Promise<AuthResult>;
  /** Resolve a token back to a principal, or `null` if it is invalid/expired. */
  verify(token: AuthToken): Promise<Principal | null>;
}

/**
 * What `POST /api/register` and `POST /api/login` answer. The token goes in
 * `Authorization: Bearer <token>` on later requests, and as `?token=` on a
 * socket, since a browser cannot set headers on a WebSocket.
 */
export interface LoginResponse {
  readonly token: AuthToken;
  readonly user: Principal;
}

/** A refused register or login, with a sentence the page can show as it is. */
export interface AuthFailure {
  readonly error: string;
  readonly reason: 'username_invalid' | 'password_invalid' | 'username_taken' | 'wrong_credentials' | 'bad_request';
}
