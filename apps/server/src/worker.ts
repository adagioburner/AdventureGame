import { asGameId, type GameId } from '@adventure/core';
import type { AuthFailure, Principal } from '@adventure/protocol';
import { lobbyOf, NAME_HEADER, roomOf, USER_HEADER, type Env } from './env.ts';

export { GameRoom } from './room.ts';
export { Lobby } from './lobby.ts';

/**
 * The site's one Worker (`docs/STACK.md` §5): the pages, the account
 * endpoints and the sockets.
 *
 *   POST /api/register, /api/login   {username, password} → LoginResponse
 *   POST /api/logout                 Authorization: Bearer <token>
 *   GET  /api/me                     Authorization: Bearer <token> → Principal
 *   GET  /api/lobby?token=           the game list's socket
 *   GET  /api/games/<id>?token=      one game's socket
 *   anything else                    the built site
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, url, env);
    } catch (error) {
      console.error(error);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, url: URL, env: Env): Promise<Response> {
  const lobby = lobbyOf(env);
  const path = url.pathname;

  if (request.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
    const body = await credentials(request);
    if (body === null) return json(failure('Send a username and a password.'), 400);
    const outcome =
      path === '/api/register' ? await lobby.register(body.username, body.password) : await lobby.logIn(body.username, body.password);
    if (outcome.ok) return json(outcome.login, 200);
    return json(outcome.failure, outcome.failure.reason === 'wrong_credentials' ? 401 : 400);
  }

  if (request.method === 'POST' && path === '/api/logout') {
    const token = bearer(request);
    if (token !== null) await lobby.logOut(token);
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET' && path === '/api/me') {
    const user = await signedIn(request, env);
    return user === null ? json(failure('You are not logged in.'), 401) : json(user, 200);
  }

  const game = /^\/api\/games\/([a-z0-9]{4,32})$/.exec(path);
  if (request.method === 'GET' && (path === '/api/lobby' || game !== null)) {
    if (request.headers.get('Upgrade') !== 'websocket') return json(failure('This address takes a WebSocket.'), 426);
    const user = await signedIn(request, env);
    if (user === null) return json(failure('You are not logged in.'), 401);
    const forwarded = new Request(url.toString(), {
      headers: {
        Upgrade: 'websocket',
        [USER_HEADER]: user.userId,
        [NAME_HEADER]: user.displayName,
      },
    });
    const gameId: GameId | null = game?.[1] === undefined ? null : asGameId(game[1]);
    return gameId === null ? lobby.fetch(forwarded) : roomOf(env, gameId).fetch(forwarded);
  }

  return json(failure('There is nothing at this address.'), 404);
}

/** The login a request carries: `Authorization: Bearer`, or `?token=` on a socket. */
async function signedIn(request: Request, env: Env): Promise<Principal | null> {
  const token = bearer(request) ?? new URL(request.url).searchParams.get('token');
  return token === null || token.length === 0 ? null : lobbyOf(env).verify(token);
}

function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization');
  return header !== null && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

async function credentials(request: Request): Promise<{ username: string; password: string } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { username, password } = body as { username?: unknown; password?: unknown };
  return typeof username === 'string' && typeof password === 'string' ? { username, password } : null;
}

function failure(error: string): AuthFailure {
  return { error, reason: 'bad_request' };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
