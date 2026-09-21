import type { GameId, NodeId, PlayerId, Seat } from './ids.ts';
import type { GameMap } from './gamemap.ts';
import type { MovementAllowance, PlayerState } from './player.ts';
import type { PoiRuntimeState } from './poi.ts';
import type { BoardPost } from './messageboard.ts';

export type GameStatus = 'setup' | 'in_progress' | 'finished';

/** State scoped to the player whose turn it currently is. */
export interface TurnState {
  /** 1-based count of individual player turns taken so far. */
  readonly number: number;
  /** [SOURCE §2, chat] Turn order is fixed at game start and never changes. */
  readonly activeSeat: Seat;
  /**
   * [SOURCE §2] Free steps still available on each terrain this turn. Refreshed
   * from the active player's moving-skill levels at the start of every turn,
   * independently per terrain.
   */
  readonly allowance: MovementAllowance;
}

/**
 * The full authoritative state of one game.
 *
 * `map` is an immutable shared reference — the generated world never changes —
 * so cloning a state for MCTS search (§9) copies only the small mutable part.
 * `poiRuntime` is a dense array parallel to `map.pois` for the same reason.
 *
 * [SOURCE §2] There is no hidden information, so this whole structure (minus
 * the server-side die stream) is safe to send to every client verbatim.
 */
export interface GameState {
  readonly id: GameId;
  readonly map: GameMap;
  /** Ordered by seat; `players[seat - 1]`. */
  readonly players: readonly PlayerState[];
  readonly turn: TurnState;
  /** Parallel to `map.pois`. */
  readonly poiRuntime: readonly PoiRuntimeState[];
  /**
   * [SOURCE §12.3, chat] The message board is game state, with no distinction
   * from the rest of it — so it is persisted, replayed and broadcast by exactly
   * the same machinery, and needs no store or retention policy of its own.
   */
  readonly messageBoard: readonly BoardPost[];
  readonly status: GameStatus;
  /** Empty until `status === 'finished'`; more than one entry on a shared win. */
  readonly winners: readonly PlayerId[];
}

export function playerBySeat(state: GameState, seat: Seat): PlayerState {
  const player = state.players[seat - 1];
  if (player === undefined) throw new RangeError(`no player in seat ${seat}`);
  return player;
}

export function activePlayer(state: GameState): PlayerState {
  return playerBySeat(state, state.turn.activeSeat);
}

export function playerById(state: GameState, id: PlayerId): PlayerState {
  const player = state.players.find((candidate) => candidate.id === id);
  if (player === undefined) throw new RangeError(`no such player ${id}`);
  return player;
}

/** Runtime state of the POI on `node`, or `undefined` if the node has no POI. */
export function poiRuntimeAt(state: GameState, node: NodeId): PoiRuntimeState | undefined {
  const index = state.map.poiByNode.get(node);
  return index === undefined ? undefined : state.poiRuntime[index];
}
