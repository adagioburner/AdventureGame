import { NotImplementedError } from '../errors.ts';
import type { DieRoll, GameAction, GameEvent } from '../action.ts';
import type { GameState } from '../state.ts';

/**
 * Supplies `GUARD_DIE` rolls. The engine never owns randomness: the session
 * layer injects a server-side stream (kept separate from the public map seed so
 * clients cannot precompute rolls — no hidden information applies to the map
 * and rewards, §1, not to future dice), and MCTS injects its own.
 */
export interface DiceSource {
  roll(): DieRoll;
}

export interface ActionOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * The single entry point for changing a game: pure, deterministic given
 * `dice`, and the only writer of `GameState`.
 *
 * Everything else — the session layer, the AI, the balancing harness, replays —
 * drives the game exclusively through this function, which is what lets MCTS
 * (§9) search real game states rather than an approximation of them.
 *
 * Sequence for a turn action (§7, §8): resolve movement → if the turn ends on
 * an unclaimed POI, interact automatically → if a gold reward was claimed,
 * re-evaluate the win condition (§1) → end the turn and advance to the next
 * seat, refreshing that player's allowance (§7).
 */
export function applyAction(_state: GameState, _action: GameAction, _dice: DiceSource): ActionOutcome {
  throw new NotImplementedError('applyAction', 'GDD.md §7, §8');
}

/**
 * [SOURCE §2, chat] Turn order is fixed at game start and never changes, so
 * this is a plain cycle through seats. Resigned players are not skipped — an AI
 * takes over and keeps playing their seat (§7.3).
 */
export function nextSeat(_state: GameState): number {
  throw new NotImplementedError('nextSeat', 'GDD.md §6, §7');
}
