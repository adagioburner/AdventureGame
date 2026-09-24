import type { GameId } from '@adventure/core';
import type { GameRoom } from './room.ts';
import type { Lobby } from './lobby.ts';

/** The Worker's bindings, as `wrangler.jsonc` declares them. */
export interface Env {
  /** One object per game, named by its `gameId`. */
  readonly GAMES: DurableObjectNamespace<GameRoom>;
  /** One object for the whole site: accounts, logins and the game list. */
  readonly LOBBY: DurableObjectNamespace<Lobby>;
  /** The built site (`apps/web`, `pnpm build:site`). */
  readonly ASSETS: Fetcher;
}

/**
 * Who a socket belongs to, set by the Worker after it has checked the login
 * token and never taken from the browser: the Worker builds the request it
 * forwards, so a header a browser sends does not get through.
 */
export const USER_HEADER = 'X-Adventure-User';
export const NAME_HEADER = 'X-Adventure-Name';

export function lobbyOf(env: Env): DurableObjectStub<Lobby> {
  return env.LOBBY.get(env.LOBBY.idFromName('lobby'));
}

export function roomOf(env: Env, gameId: GameId): DurableObjectStub<GameRoom> {
  return env.GAMES.get(env.GAMES.idFromName(gameId));
}
