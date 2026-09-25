import { DurableObject } from 'cloudflare:workers';
import { asGameId, asUserId, type GameId, type UserId } from '@adventure/core';
import {
  AWAY_AFTER_MS,
  decodeClientMessage,
  encodeMessage,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  WireError,
  type ServerMessage,
} from '@adventure/protocol';
import { GameSession, SetupError, type NewSetup } from '@adventure/session';
import {
  createDurableGameStore,
  createSecureDiceService,
  createSocketBroadcaster,
  userSocketTag,
  wasRemoved,
} from './adapters/durable-object.ts';
import { systemClock } from './adapters/memory.ts';
import { lobbyOf, USER_HEADER, type Env } from './env.ts';
import { closeQuietly } from './lobby.ts';
import { SETUP_LIMITS } from './limits.ts';

interface RoomSocket {
  readonly userId: UserId;
  /** When the socket opened, which counts as hearing from it until its first ping. */
  readonly openedAt: number;
}

const GAME_ID_KEY = 'gameId';
/** The people last told they were away, so a change is sent once. */
const AWAY_KEY = 'away';

/**
 * One game (§12.1, `docs/STACK.md` §5): its setup and, once started, its
 * state, and the sockets of everyone who has it open. `GameSession` does the
 * work; this object gives it storage, sockets, dice and the lobby, feeds it
 * one message at a time, and wakes it on an alarm.
 *
 * Handling a message can wait on the lobby (the game list's row), and a
 * Durable Object may take the next message while it waits, so messages go
 * through a queue rather than relying on the object alone to keep them apart.
 *
 * [Q54, 31] Who is away: every open page sends a ping every 20 seconds, which
 * Cloudflare answers without waking the object and notes the time of. While
 * the game is in progress the object's alarm goes off every 20 seconds to read
 * those times, and anyone whose pages have all been silent for a minute, or
 * who has closed them, is away. The same alarm carries the game's lifetime
 * ([Q55]): whichever is sooner, the next check or the game's own deadline.
 */
export class GameRoom extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();
  private readonly dice = createSecureDiceService();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
  }

  /** Called by the lobby, once, right after it names the game. */
  async create(gameId: GameId, game: Omit<NewSetup, 'gameId' | 'createdAt'>): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.inTurn(async () => {
      if ((await this.ctx.storage.get<string>(GAME_ID_KEY)) !== undefined) return { ok: false, message: 'that game exists already' };
      await this.ctx.storage.put(GAME_ID_KEY, gameId);
      try {
        await this.session(gameId).create(game);
        await this.schedule(gameId);
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
    const who: RoomSocket = { userId: asUserId(userId), openedAt: Date.now() };
    this.ctx.acceptWebSocket(server, [userSocketTag(who.userId)]);
    server.serializeAttachment(who);
    void this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) {
        server.send(
          encodeMessage(
            (await wasRemoved(this.ctx.storage))
              ? { type: 'error', code: 'game_removed', message: 'this game has ended and been removed' }
              : { type: 'error', code: 'game_not_found', message: 'there is no such game' },
          ),
        );
        return;
      }
      await this.session(gameId).connected(who.userId);
      await this.checkPresence(gameId, server);
      await this.schedule(gameId);
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
      await this.schedule(gameId);
    });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeQuietly(ws, code, reason);
    await this.socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.socketGone(ws);
  }

  /** [Q54, 31] and [Q55]: the regular check of who is away, and the game's lifetime. */
  override async alarm(): Promise<void> {
    await this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) return;
      await this.session(gameId).wake();
      if (await wasRemoved(this.ctx.storage)) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.checkPresence(gameId);
      await this.schedule(gameId);
    });
  }

  /** [Q54, 31] "a player [...] who closed the game is away" at once. */
  private async socketGone(ws: WebSocket): Promise<void> {
    await this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) return;
      await this.checkPresence(gameId, null, ws);
      await this.schedule(gameId);
    });
  }

  /**
   * Works out who is away and tells everyone when that has changed; `joined`,
   * a socket that has just opened, is told in any case. `leaving` is a socket
   * that is closing and no longer counts.
   */
  private async checkPresence(gameId: GameId, joined: WebSocket | null = null, leaving: WebSocket | null = null): Promise<void> {
    const setup = await createDurableGameStore(gameId, this.ctx.storage).loadSetup(gameId);
    if (setup === null) return;
    const now = Date.now();
    const members = setup.seats.map((seat) => seat.userId).filter((id): id is UserId => id !== null);
    const away = members.filter(
      (userId) =>
        !this.ctx
          .getWebSockets(userSocketTag(userId))
          .some((ws) => ws !== leaving && ws.readyState === WebSocket.READY_STATE_OPEN && now - this.lastHeard(ws) < AWAY_AFTER_MS),
    );
    const message: ServerMessage = { type: 'game.presence', gameId, away };
    const before = (await this.ctx.storage.get<UserId[]>(AWAY_KEY)) ?? null;
    if (before === null || before.join('\n') !== away.join('\n')) {
      await this.ctx.storage.put(AWAY_KEY, away);
      await createSocketBroadcaster(gameId, this.ctx).broadcast(gameId, message);
    } else if (joined !== null) {
      joined.send(encodeMessage(message));
    }
  }

  /** When the page on `ws` was last heard from: its last ping, or its opening. */
  private lastHeard(ws: WebSocket): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const opened = (ws.deserializeAttachment() as RoomSocket | null)?.openedAt ?? 0;
    return Math.max(pinged, opened);
  }

  /**
   * Sets the one alarm an object has for the sooner of the game's own
   * deadline ([Q55]) and, while it is being played with someone connected,
   * the next check of who is away ([Q54, 31]).
   */
  private async schedule(gameId: GameId): Promise<void> {
    if (await wasRemoved(this.ctx.storage)) return;
    let next = await this.session(gameId).nextDeadline();
    const game = await createDurableGameStore(gameId, this.ctx.storage).load(gameId);
    const watched = this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
    if (game !== null && game.status === 'in_progress' && watched) {
      const check = Date.now() + HEARTBEAT_INTERVAL_MS;
      next = next === null ? check : Math.min(next, check);
    }
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
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
        dice: this.dice,
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
