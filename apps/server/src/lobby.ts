import { DurableObject } from 'cloudflare:workers';
import { asGameId, asUserId, friendlySeed, type GameId, type UserId } from '@adventure/core';
import {
  decodeClientMessage,
  encodeMessage,
  type AuthFailure,
  type AuthResult,
  type AuthToken,
  type LoginResponse,
  type Principal,
  type ServerMessage,
} from '@adventure/protocol';
import type { GameListing } from '@adventure/session';
import { createSqlAccountStore, userSocketTag } from './adapters/durable-object.ts';
import { systemClock } from './adapters/memory.ts';
import { AccountError, PasswordAccounts } from './auth/accounts.ts';
import { ACCOUNT_RULES } from './auth/rules.ts';
import { NAME_HEADER, USER_HEADER, roomOf, type Env } from './env.ts';
import { createSqlListingStore, gameListFor, type ListingStore } from './games.ts';

export type AccountOutcome = { readonly ok: true; readonly login: LoginResponse } | { readonly ok: false; readonly failure: AuthFailure };

interface LobbySocket {
  readonly userId: UserId;
  readonly displayName: string;
}

/**
 * The one object for the whole site: accounts and logins (§6.1, Q48 2 to 4)
 * and the list of games (Q48 5), kept in its SQLite. Games report their rows
 * here as they change (`updateGame`), and every open game-list page is sent
 * its user's list again.
 */
export class Lobby extends DurableObject<Env> {
  private readonly accounts: PasswordAccounts;
  private readonly listings: ListingStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.accounts = new PasswordAccounts(createSqlAccountStore(ctx.storage.sql), ACCOUNT_RULES, systemClock);
    this.listings = createSqlListingStore(ctx.storage.sql);
  }

  register(username: string, password: string): Promise<AccountOutcome> {
    return this.account(() => this.accounts.register({ method: 'password', username, password }));
  }

  logIn(username: string, password: string): Promise<AccountOutcome> {
    return this.account(() => this.accounts.authenticate({ method: 'password', username, password }));
  }

  verify(token: string): Promise<Principal | null> {
    return this.accounts.verify(token as AuthToken);
  }

  logOut(token: string): Promise<void> {
    return this.accounts.logOut(token as AuthToken);
  }

  /** A game's row changed, or it left the list (`null`). */
  async updateGame(gameId: GameId, listing: GameListing | null): Promise<void> {
    if (listing === null) this.listings.remove(gameId);
    else this.listings.put(listing);
    this.sendLists();
  }

  /** A game-list page's socket, already checked by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    if (request.headers.get('Upgrade') !== 'websocket' || userId === null) {
      return new Response('expected a game-list socket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [userSocketTag(asUserId(userId))]);
    const who: LobbySocket = { userId: asUserId(userId), displayName: request.headers.get(NAME_HEADER) ?? '' };
    server.serializeAttachment(who);
    server.send(encodeMessage(this.listFor(who.userId)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const who = ws.deserializeAttachment() as LobbySocket;
    const reply = (message: ServerMessage): void => ws.send(encodeMessage(message));
    let message;
    try {
      message = decodeClientMessage(typeof data === 'string' ? data : '');
    } catch {
      reply({ type: 'error', code: 'invalid_action', message: 'that message could not be read' });
      return;
    }
    if (message.type !== 'lobby.create') {
      reply({ type: 'error', code: 'invalid_action', message: 'the game list only creates games' });
      return;
    }
    const gameId = newGameId();
    let created: { ok: true } | { ok: false; message: string };
    try {
      created = await roomOf(this.env, gameId).create(gameId, {
        name: message.name,
        gameMaster: { userId: who.userId, displayName: who.displayName },
        // [Q51, 25] "Play online" sends the setup the page already has.
        mapSeed: message.setup?.mapSeed ?? friendlySeed(cryptoRandom),
        ...(message.setup === undefined ? {} : { seats: message.setup.seats }),
      });
    } catch (error) {
      // The page waits for an answer, so a failure gets one too.
      console.error(error);
      created = { ok: false, message: 'the game could not be created; try again' };
    }
    reply(created.ok ? { type: 'lobby.created', gameId } : { type: 'error', code: 'invalid_action', message: created.message });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, code, reason);
  }

  private listFor(userId: UserId): ServerMessage {
    return { type: 'lobby.games', games: gameListFor(userId, this.listings.all()) };
  }

  private sendLists(): void {
    const all = this.listings.all();
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment() as LobbySocket;
      try {
        ws.send(encodeMessage({ type: 'lobby.games', games: gameListFor(who.userId, all) }));
      } catch {
        // A closing socket; its page asks again when it reconnects.
      }
    }
  }

  private async account(attempt: () => Promise<AuthResult>): Promise<AccountOutcome> {
    try {
      const { principal, token } = await attempt();
      return { ok: true, login: { token, user: principal } };
    } catch (error) {
      if (error instanceof AccountError) return { ok: false, failure: { error: error.message, reason: error.reason } };
      throw error;
    }
  }
}

/** Ten random base-32 characters: unguessable enough to name a game, short enough for an address. */
/**
 * A number in [0, 1) from the platform's secure generator. With `Math.random`
 * here, every game made in the local Workers runtime got a seed with its word
 * twice ("cairn-cairn-533", three games in a row); a plain Worker's
 * `Math.random` looked fine, and the cause was not found.
 */
function cryptoRandom(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;
}

function newGameId(): GameId {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return asGameId(Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(''));
}

export function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code === 1005 ? 1000 : code, reason);
  } catch {
    // Already closed.
  }
}
