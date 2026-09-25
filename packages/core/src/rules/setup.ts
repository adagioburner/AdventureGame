import { startingStaminaForSeat } from '@adventure/config';
import { RuleViolationError } from '../errors.ts';
import type { GameMap } from '../gamemap.ts';
import type { GameId, NodeId, PlayerId } from '../ids.ts';
import { initialStats, type ControlMode, type PlayerState } from '../player.ts';
import type { PoiRuntimeState } from '../poi.ts';
import type { GameState } from '../state.ts';
import { refreshAllowance } from './movement.ts';

/** What §6.1's setup flow has settled on by the time a game can start. */
export interface NewGamePlayer {
  readonly id: PlayerId;
  readonly name: string;
  /** Opaque to the engine; resolved to a figurine by the client (§10). */
  readonly avatarId: string;
  readonly control: ControlMode;
}

export interface NewGame {
  readonly id: GameId;
  readonly map: GameMap;
  /**
   * In seat order: `players[0]` takes seat 1 and moves first. [SOURCE §2, chat]
   * Turn order is fixed here and never changes; §6.1 fixes it as the order the
   * game master accepted join requests, which is the caller's business.
   */
  readonly players: readonly NewGamePlayer[];
  /**
   * [SOURCE §6, chat] "the players start at a random spot of the plains that is
   * not a POI. All players start from the same spot." Passed in rather than
   * drawn here so this function stays pure — production callers get it from
   * `chooseStartingNode(map, createRng(map.seed).fork(…))`, which replays with
   * the map.
   */
  readonly startingNode: NodeId;
}

/**
 * Build the state a game starts from: the one function that produces a
 * `GameState` other than `applyAction`.
 *
 * It exists in the engine rather than in the session layer because three
 * consumers need a game to exist before they can play one — §6.1's setup flow,
 * the hotseat client, and every test and rollout that drives `applyAction` in a
 * loop — and three private copies of §6's starting stats would be three chances
 * to disagree.
 */
export function createGameState(game: NewGame): GameState {
  const { PLAYER_COUNT } = game.map.ruleset.config.players;
  if (game.players.length < PLAYER_COUNT.min || game.players.length > PLAYER_COUNT.max) {
    throw new RuleViolationError(
      `a game takes ${PLAYER_COUNT.min}–${PLAYER_COUNT.max} players, got ${game.players.length}`,
    );
  }

  const players: readonly PlayerState[] = game.players.map((player, index) => {
    const seat = index + 1;
    return {
      id: player.id,
      seat,
      name: player.name,
      avatarId: player.avatarId,
      control: player.control,
      resigned: false,
      // [SOURCE §2, chat] Every stat starts at zero except stamina, which is
      // higher the later you move — the compensation for seat order.
      stats: initialStats(startingStaminaForSeat(seat, game.map.ruleset)),
      position: game.startingNode,
      plannedPath: null,
    };
  });

  const first = players[0];
  if (first === undefined) throw new RuleViolationError('a game needs at least one player');

  const unclaimed: PoiRuntimeState = { claimedBy: null, claimedOnTurn: null };

  return {
    id: game.id,
    map: game.map,
    players,
    turn: {
      number: 1,
      activeSeat: first.seat,
      allowance: refreshAllowance(first.stats),
    },
    poiRuntime: game.map.pois.map(() => unclaimed),
    messageBoard: [],
    status: 'in_progress',
    winners: [],
    ending: null,
  };
}
