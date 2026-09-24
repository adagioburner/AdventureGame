import { asUserId, type GameId, type GameState, type UserId } from '@adventure/core';
import { encodeMessage, type ServerMessage, type SetupState } from '@adventure/protocol';
import type { Broadcaster, GameStore } from '@adventure/session';
import type { AccountRecord, AccountStore } from '../auth/accounts.ts';
import type { PasswordHash } from '../auth/password.ts';

/**
 * Cloudflare Durable Object adapters for the session ports.
 *
 * Hosting is decided (§12.1, `docs/STACK.md` §5): one Durable Object per
 * `gameId`, which gives `GameSession` the single-writer guarantee it already
 * assumes. The mapping:
 *
 *   - `GameStore`   → the object's own transactional storage;
 *   - `Broadcaster` → the object's hibernating WebSockets, each tagged with the
 *     user it belongs to;
 *   - `Clock`       → `systemClock` from `memory.ts`, which is `Date.now()`;
 *   - the accounts behind `PasswordAccounts` → SQLite in the one lobby
 *     object, which also keeps the list of games (one index across all the
 *     game objects, `docs/IMPLEMENTATION_PLAN.md` phase 6 item 5);
 *   - `MapService` and `AiService` → round trips to the game master's browser
 *     (phase 8 for the AI; the map at Start), never computed here.
 *
 * These functions take the two slices of the Durable Object they use rather
 * than the object itself, so the Workers types stay in `room.ts` and the
 * adapters run under plain Vitest against fakes.
 */

/** The part of `DurableObjectStorage` a game store uses. */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** The part of a Workers `WebSocket` a broadcaster uses. */
export interface SocketLike {
  send(message: string): void;
}

/** The part of `DurableObjectState` that finds hibernating sockets. */
export interface SocketDirectory {
  getWebSockets(tag?: string): SocketLike[];
}

/** The tag every socket of one user carries, so `sendTo` can find them all. */
export function userSocketTag(userId: UserId): string {
  return `user:${userId}`;
}

const STATE_KEY = 'state';
const SETUP_KEY = 'setup';

/**
 * One object holds one game, so the store keeps a single state and a single
 * setup under fixed keys and refuses any other game's — that would be a
 * routing bug. Storage writes are structured-cloned, so `GameMap.poiByNode`
 * stays a `Map`.
 */
export function createDurableGameStore(gameId: GameId, storage: DurableStorageLike): GameStore {
  const mine = (id: GameId, what: string): void => {
    if (id !== gameId) throw new RangeError(`${what} for ${id} saved to the object for ${gameId}`);
  };
  return {
    load: async (id) => (id === gameId ? ((await storage.get<GameState>(STATE_KEY)) ?? null) : null),
    save: async (state) => {
      mine(state.id, 'game');
      await storage.put(STATE_KEY, state);
    },
    loadSetup: async (id) => (id === gameId ? ((await storage.get<SetupState>(SETUP_KEY)) ?? null) : null),
    saveSetup: async (setup) => {
      mine(setup.gameId, 'setup');
      await storage.put(SETUP_KEY, setup);
    },
  };
}

/**
 * Every socket in the object belongs to the one game, so `broadcast` sends to
 * all of them. A user may have several tabs open; `sendTo` reaches each.
 * A socket that fails to send is closing already and is skipped: its owner
 * reloads the whole state on reconnect.
 */
export function createSocketBroadcaster(gameId: GameId, sockets: SocketDirectory): Broadcaster {
  const sendAll = (targets: readonly SocketLike[], message: ServerMessage): void => {
    const text = encodeMessage(message);
    for (const socket of targets) {
      try {
        socket.send(text);
      } catch {
        // Closing socket; see above.
      }
    }
  };
  return {
    broadcast: async (id, message) => {
      if (id !== gameId) throw new RangeError(`broadcast for ${id} from the object for ${gameId}`);
      sendAll(sockets.getWebSockets(), message);
    },
    sendTo: async (userId, message) => {
      sendAll(sockets.getWebSockets(userSocketTag(userId)), message);
    },
  };
}

/** The part of a SQLite-backed object's `storage.sql` the account store uses. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, string | number | null | ArrayBuffer>[] };
}

/**
 * Accounts and logins in the lobby object's SQLite (§6.1). Every call runs
 * inside the one object, and SQL there is synchronous, so the check-then-insert
 * in `insertAccount` cannot interleave with another registration.
 */
export function createSqlAccountStore(sql: SqlLike): AccountStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS logins (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER
  )`);

  const account = (row: Record<string, unknown> | undefined): AccountRecord | null =>
    row === undefined
      ? null
      : {
          userId: asUserId(String(row['user_id'])),
          username: String(row['username']),
          key: String(row['key']),
          password: JSON.parse(String(row['password'])) as PasswordHash,
          createdAt: Number(row['created_at']),
        };

  return {
    accountByKey: async (key) => account(sql.exec('SELECT * FROM accounts WHERE key = ?', key).toArray()[0]),
    accountById: async (userId) => account(sql.exec('SELECT * FROM accounts WHERE user_id = ?', userId).toArray()[0]),
    insertAccount: async (record) => {
      if (sql.exec('SELECT 1 FROM accounts WHERE key = ?', record.key).toArray().length > 0) return false;
      sql.exec(
        'INSERT INTO accounts (user_id, username, key, password, created_at) VALUES (?, ?, ?, ?, ?)',
        record.userId,
        record.username,
        record.key,
        JSON.stringify(record.password),
        record.createdAt,
      );
      return true;
    },
    insertLogin: async (login) => {
      sql.exec(
        'INSERT INTO logins (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        login.tokenHash,
        login.userId,
        login.expiresAt,
      );
    },
    loginByTokenHash: async (tokenHash) => {
      const row = sql.exec('SELECT * FROM logins WHERE token_hash = ?', tokenHash).toArray()[0];
      return row === undefined
        ? null
        : {
            tokenHash: String(row['token_hash']),
            userId: asUserId(String(row['user_id'])),
            expiresAt: row['expires_at'] === null ? null : Number(row['expires_at']),
          };
    },
    deleteLogin: async (tokenHash) => {
      sql.exec('DELETE FROM logins WHERE token_hash = ?', tokenHash);
    },
  };
}
