import type { Ruleset } from '@adventure/config';
import type { DiceSource, GameId, GameMap, GameState, PlayerId, Seed, UserId } from '@adventure/core';
import type { AiPlayer } from '@adventure/ai';
import type { GameRecord, GameResult, ServerMessage, SetupState } from '@adventure/protocol';

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

/**
 * Persistence for one game's authoritative state, and for its setup (§6.1),
 * which lives on beside the game once it starts: phase 7's computer seats read
 * their thinking time from it (Q48).
 */
export interface GameStore {
  load(gameId: GameId): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
  loadSetup(gameId: GameId): Promise<SetupState | null>;
  saveSetup(setup: SetupState): Promise<void>;
  /**
   * [Q54, 32] Stores the next change of a game's history, numbering it one
   * past the last, and returns it as stored.
   */
  appendRecord(gameId: GameId, record: Omit<GameRecord, 'seq'>): Promise<GameRecord>;
  /** Every record of the game, in order. */
  loadRecords(gameId: GameId): Promise<readonly GameRecord[]>;
  /**
   * [Q55, 37] Deletes everything the game stored, keeping only the fact that
   * it was removed, so its old address can say so.
   */
  remove(gameId: GameId): Promise<void>;
  isRemoved(gameId: GameId): Promise<boolean>;
}

/**
 * What the game list (§6.1, Q48 item 5) shows for one game, and who holds a
 * seat in it. Listing spans every game, which one object per game cannot do
 * on its own, so each game reports here whenever its row changes.
 */
export interface GameListing {
  readonly gameId: GameId;
  readonly name: string;
  readonly gameMaster: UserId;
  readonly gameMasterName: string;
  readonly phase: 'setup' | 'in_progress' | 'finished';
  readonly seatsTaken: number;
  readonly seatsTotal: number;
  readonly createdAt: number;
  /** [Q55, 46] When the game's lifetime runs out. */
  readonly endsAt: number;
  readonly members: readonly UserId[];
  /** [Q54, 34] The person whose turn it is; `null` on a computer's turn and outside play. */
  readonly turnOf: UserId | null;
  /** [Q55, 36] Set once the game has finished. */
  readonly result: GameResult | null;
}

export interface GameDirectory {
  /** Records the game's row, or takes it off the list with `null`. */
  update(gameId: GameId, listing: GameListing | null): Promise<void>;
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
 * machine." So the server never executes the §2.1 pipeline.
 *
 * Phase 6 found that a Durable Object cannot hold this as an awaited promise:
 * while it waits for the game master's reply the object may hibernate, and the
 * promise goes with it. So `GameSession` does the round trip as two messages
 * instead — Start sends `gm.requestMapGeneration`, and `gm.mapGenerated`
 * finishes starting the game — and nothing implements this port. It stays as
 * the shape a server-side generator would take if generation ever moved back.
 */
export interface MapService {
  generate(seed: Seed, ruleset: Ruleset): Promise<GameMap>;
}

/**
 * [SOURCE §12.1, chat] Also on the game master's machine. For the reason
 * `MapService` gives, `GameSession` does this round trip as two messages too:
 * a computer's turn sends `gm.requestAiMove` to the game master, and
 * `gm.aiMove` plays the move. Nothing implements this port; it stays as the
 * shape a server-side computer player would take.
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
 * What `GameSession` runs on. §12.3 removed `MessageBoardStore` (the board is
 * game state, so `GameStore` already covers it) and §12.4 removed
 * `GameMasterAbsencePolicy` (there is no fallback to configure); the map and
 * the computer's moves are messages to the game master rather than ports
 * (`MapService`, `AiService`).
 */
export interface SessionPorts {
  readonly games: GameStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly directory: GameDirectory;
  readonly dice: DiceService;
}
