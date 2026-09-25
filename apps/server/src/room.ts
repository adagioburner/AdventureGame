import { DurableObject } from 'cloudflare:workers';
import { asGameId, asUserId, type GameId, type UserId } from '@adventure/core';
import { decodeClientMessage, encodeMessage, WireError } from '@adventure/protocol';
import { GameSession, SetupError, type NewSetup } from '@adventure/session';
import { createDurableGameStore, createSocketBroadcaster, userSocketTag } from './adapters/durable-object.ts';
import { systemClock } from './adapters/memory.ts';
import { lobbyOf, USER_HEADER, type Env } from './env.ts';
import { closeQuietly } from './lobby.ts';
import { SETUP_LIMITS } from './limits.ts';

interface RoomSocket {
  readonly userId: UserId;
}

const GAME_ID_KEY = 'gameId';

/**
 * One game (§12.1, `docs/STACK.md` §5): its setup and, once started, its
 * state, and the sockets of everyone who has it open. `GameSession` does the
 * work; this object gives it storage, sockets and the lobby, and feeds it one
 * message at a time.
 *
 * Handling a message can wait on the lobby (the game list's row), and a
 * Durable Object may take the next message while it waits, so messages go
 * through a queue rather than relying on the object alone to keep them apart.
 */
export class GameRoom extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  /** Called by the lobby, once, right after it names the game. */
  async create(gameId: GameId, game: Omit<NewSetup, 'gameId' | 'createdAt'>): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.inTurn(async () => {
      if ((await this.ctx.storage.get<string>(GAME_ID_KEY)) !== undefined) return { ok: false, message: 'that game exists already' };
      await this.ctx.storage.put(GAME_ID_KEY, gameId);
      try {
        await this.session(gameId).create(game);
        return { ok: true };
      } catch (error) {
        await this.ctx.storage.delete(GAME_ID_KEY);
        if (error instanceof SetupError) return { ok: false, message: error.message };
        throw error;
      }
    });
  }

  /** A socket for this game, from the Worker, which has checked the login. */
  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER);
    if (request.headers.get('Upgrade') !== 'websocket' || userId === null) {
      return new Response('expected a game socket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const who: RoomSocket = { userId: asUserId(userId) };
    this.ctx.acceptWebSocket(server, [userSocketTag(who.userId)]);
    server.serializeAttachment(who);
    void this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) {
        server.send(encodeMessage({ type: 'error', code: 'game_not_found', message: 'there is no such game' }));
        return;
      }
      await this.session(gameId).connected(who.userId);
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const who = ws.deserializeAttachment() as RoomSocket;
    await this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) return;
      let message;
      try {
        message = decodeClientMessage(typeof data === 'string' ? data : '');
      } catch (error) {
        if (!(error instanceof WireError)) throw error;
        ws.send(encodeMessage({ type: 'error', code: 'invalid_action', message: 'that message could not be read' }));
        return;
      }
      try {
        await this.session(gameId).handle(who.userId, message);
      } catch (error) {
        // `handle` answers every refusal itself; this is anything else, and
        // the page should hear that its change did not happen.
        console.error(error);
        ws.send(encodeMessage({ type: 'error', code: 'invalid_action', message: 'something went wrong on the server; try again' }));
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, code, reason);
  }

  private async gameId(): Promise<GameId | null> {
    const id = await this.ctx.storage.get<string>(GAME_ID_KEY);
    return id === undefined ? null : asGameId(id);
  }

  private session(gameId: GameId): GameSession {
    return new GameSession(
      gameId,
      {
        games: createDurableGameStore(gameId, this.ctx.storage),
        broadcaster: createSocketBroadcaster(gameId, this.ctx),
        clock: systemClock,
        directory: { update: (id, listing) => lobbyOf(this.env).updateGame(id, listing) },
      },
      SETUP_LIMITS,
    );
  }

  /** Runs `work` after everything queued before it, whatever happened to that. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
