import type { GameConfig } from '@adventure/config';
import type { DieRoll } from '../action.ts';
import type { Rng } from '../rng.ts';
import type { DiceSource } from './turn.ts';

/**
 * One roll of §11's `GUARD_DIE` (1d6) from a seeded stream.
 *
 * `count` dice are summed, so the value of the default 1d6 is 1–6 and a
 * hypothetical 2d6 would be 2–12 — which is the range `resolveInteraction`
 * checks an incoming roll against.
 */
export function rollGuardDie(rng: Rng, config: GameConfig): DieRoll {
  const { count, sides } = config.combat.GUARD_DIE;
  let value = 0;
  for (let die = 0; die < count; die++) value += rng.nextIntInclusive(1, sides);
  return { value, sides };
}

/**
 * The one `DiceSource` implementation in the repo, over an injected `Rng`.
 *
 * Every consumer needs one and none of them may invent its own: the server's is
 * seeded from a stream kept apart from the public map seed (§1's
 * no-hidden-information rule covers the map and its rewards, not future dice),
 * hotseat has no server so it draws locally, and MCTS rolls from its own stream
 * inside the search. What they vary is the `Rng`, never the die.
 */
export function createDiceSource(rng: Rng, config: GameConfig): DiceSource {
  return { roll: () => rollGuardDie(rng, config) };
}
