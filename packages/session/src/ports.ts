import type { Ruleset } from '@adventure/config';
import type { DiceSource, GameId, GameMap, GameState, PlayerId, Seed, UserId } from '@adventure/core';
import type { AiPlayer } from '@adventure/ai';
import type { ServerMessage } from '@adventure/protocol';

/**
 * The session layer's ports. Every one of these is an interface with no
 * implementation in this package.
 *
 * [SOURCE §12.1, chat] Hosting is now decided — Durable Objects — "with
 * flexible architecture to swap it for something else if DO don't fit the
 * bill". These ports are that flexibility, so the rule here stays absolute:
 * this package imports nothing runtime-specific — no WebSocket, no KV, no SQL,
 * no Durable Object, no `setTimeout`. The DO is an adapter in `apps/server`,
 * and swapping it means writing a different adapter, not touching this package.
 */

/** Persistence for one game's authoritative state. */
export interface GameStore {
  load(gameId: GameId): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
}

/** Fan-out to everyone watching a game. */
export interface Broadcaster {
  broadcast(gameId: GameId, message: ServerMessage): Promise<void>;
  sendTo(userId: UserId, message: ServerMessage): Promise<void>;
}

/** Injected so nothing in the engine or session reads a global clock. */
export interface Clock {
  now(): number;
}

/**
 * [SOURCE §12.1, chat] "Map generation and player AI run on the game master's
 * machine." So the server never executes the §2.1 pipeline. The Durable Object
 * adapter implements this port as a **round trip to the game master's client**:
 * send `gm.requestMapGeneration`, await `gm.mapGenerated`.
 *
 * The session core is unaware of any of that — which is the point of the port,
 * and why moving generation back server-side later would change one adapter.
 */
export interface MapService {
  generate(seed: Seed, ruleset: Ruleset): Promise<GameMap>;
}

/**
 * [SOURCE §12.1, chat] Also on the game master's machine. The DO adapter
 * implements this as a round trip too: send `gm.requestAiMove`, await
 * `gm.aiMove`.
 *
 * This is why `AiPlayer.chooseAction` was already async and behind a port: 10
 * seconds of CPU per move (§9) never belonged in a request handler, and it now
 * does not even run on the server. On the GM's machine it belongs in a Web
 * Worker so the search does not freeze that player's own UI.
 */
export interface AiService {
  playerFor(gameId: GameId, player: PlayerId): Promise<AiPlayer>;
}

/**
 * [SOURCE §2] The authoritative `GUARD_DIE` stream (§8), server-side.
 *
 * Kept separate from the public map seed: §1's no-hidden-information rule is
 * about the map, POIs and rewards, all of which the client receives in full. It
 * says nothing about letting a client precompute future dice, and a shared seed
 * would do exactly that.
 */
export interface DiceService {
  forGame(gameId: GameId): Promise<DiceSource>;
}

/**
 * §12.4 is decided, and the decision is that there is no fallback.
 *
 * [SOURCE §12.4, chat] "The game cannot proceed for a player that cannot
 * establish connection with the game state server. If the game master
 * disconnects there is no one to force the next turn so the game stalls as
 * well."
 *
 * So there is no policy port here any more — nothing is configurable, because
 * nothing happens. A GM-only request with no game master connected is answered
 * `game_master_unavailable` and the game waits.
 *
 * Note the reach of this, which follows from §12.1 rather than §12.4 itself:
 * with map generation and MCTS on the game master's machine, a disconnected GM
 * blocks not only forced turns but **every AI turn and map creation**. An
 * all-AI game still cannot advance without the GM online. Recorded as a
 * consequence of the two answers together, not as a new question.
 */
export const GAME_MASTER_ABSENCE_BEHAVIOUR = 'stall' as const;

/**
 * Six ports, down from eight: §12.3 removed `MessageBoardStore` (the board is
 * game state, so `GameStore` already covers it) and §12.4 removed
 * `GameMasterAbsencePolicy` (there is no fallback to configure).
 */
export interface SessionPorts {
  readonly games: GameStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  /** Round-trips to the game master's client; see the interface. */
  readonly maps: MapService;
  /** Round-trips to the game master's client; see the interface. */
  readonly ai: AiService;
  readonly dice: DiceService;
}
