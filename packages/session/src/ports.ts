import type { DiceSource, GameId, GameState, UserId } from '@adventure/core';
import type { GameRecord, GameResult, ServerMessage, SetupState } from '@adventure/protocol';

/**
 * The session layer's ports. Every one of these is an interface with no
 * implementation in this package.
 *
 * [SOURCE §12.1, chat] Hosting is decided — Durable Objects — "with
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
   * [Q85, 299] Stores `record` in place of the one with its `seq`, which
   * must exist. The only change a record ever takes: a deleted post's words
   * erased from the record that posted it.
   */
  replaceRecord(gameId: GameId, record: GameRecord): Promise<void>;
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
 * What `GameSession` runs on. [SOURCE §12.1, chat] "Map generation and player
 * AI run on the game master's machine", and neither is a port, since a Durable
 * Object may sleep while it waits on that browser. The map is two messages
 * (`gm.requestMapGeneration`, answered by `gm.mapGenerated`), and a computer's
 * move arrives as `gm.aiMove`.
 */
export interface SessionPorts {
  readonly games: GameStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly directory: GameDirectory;
  readonly dice: DiceService;
}
