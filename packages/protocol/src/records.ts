import {
  applyAction,
  createGameState,
  RuleViolationError,
  startingNodeFor,
  type ActionOutcome,
  type DiceSource,
  type DieRoll,
  type GameAction,
  type GameMap,
  type GameState,
  type UserId,
} from '@adventure/core';
import type { SetupState } from './lobby.ts';

/**
 * One change the server made to a game during play, as it stores it and
 * sends it.
 *
 * [Q54, 32] "The server keeps a record of each turn, so a reload does not
 * empty anyone's log." A record holds the action and the rolls it drew, so
 * `applyAction` over the records, from the state the game started in, gives
 * every state the game has been in: that is how a page that opens mid-game
 * fills its turn log, and how every page follows play (`game.played`).
 * Rolls, once drawn, are no secret; the server's future rolls are (§8).
 */
export interface GameRecord {
  /** 1 for the first change after the start, then one more each time. */
  readonly seq: number;
  readonly action: GameAction;
  /** The `GUARD_DIE` rolls the action drew, in order; empty for most. */
  readonly rolls: readonly DieRoll[];
  /** When the server applied it, milliseconds since 1970. */
  readonly at: number;
  /**
   * Who sent it: the player, or the game master for a forced move (§7.3), a
   * computer's move and ending the game; `null` for the server itself, when a
   * game's time runs out ([Q55, 45]).
   */
  readonly by: UserId | null;
}

/** Applies a record to the state before it, rolling exactly the rolls it recorded. */
export function replayRecord(state: GameState, record: GameRecord): ActionOutcome {
  return applyAction(state, record.action, recordedDice(record.rolls));
}

/** A `DiceSource` that gives back recorded rolls, and refuses to invent another. */
export function recordedDice(rolls: readonly DieRoll[]): DiceSource {
  let next = 0;
  return {
    roll: () => {
      const roll = rolls[next++];
      if (roll === undefined) throw new RuleViolationError('the record has no roll left for this action');
      return roll;
    },
  };
}

/**
 * The state a game started in, from its setup as Start left it and its map:
 * every seat in seat order, all on the starting node (§6). The server starts
 * the game with it, and a page replays the records from it.
 */
export function openingStateOf(setup: SetupState, map: GameMap): GameState {
  return createGameState({
    id: setup.gameId,
    map,
    players: setup.seats.map((seat) => ({
      id: seat.playerId,
      name: seat.name,
      avatarId: seat.avatarId,
      control: seat.control,
    })),
    startingNode: startingNodeFor(map),
  });
}
