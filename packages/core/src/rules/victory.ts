import { NotImplementedError } from '../errors.ts';
import type { PlayerId } from '../ids.ts';
import type { GameState } from '../state.ts';

/**
 * [SOURCE §2] Gold still unclaimed on the map — the threshold the win
 * condition compares a lead against.
 */
export function unclaimedGoldUnits(state: GameState): number {
  let total = 0;
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined || poi.reward.kind !== 'gold') continue;
    if (state.poiRuntime[index]?.claimedBy === null) total += poi.reward.units;
  }
  return total;
}

/**
 * [SOURCE §2] "A player wins once their gold lead over every other player
 * exceeds the amount of gold still unclaimed on the map [evaluated each time a
 * POI with gold is claimed]; a tie for the win results in shared victory."
 *
 * Left unimplemented on purpose. The two clauses do not compose under a literal
 * reading: if two players are tied at the top, each one's lead over the other
 * is 0, which never exceeds a non-negative amount of unclaimed gold, so a
 * "tie for the win" could never arise at all. The sentence only makes sense if
 * tied leaders are evaluated as a bloc against the best *other* player — but
 * that is a reading, not something the GDD states. See OPEN_QUESTIONS Q3.
 *
 * Returns the winners (one, or several on a shared victory), or an empty array
 * if nobody has won yet.
 */
export function checkVictory(_state: GameState): readonly PlayerId[] {
  throw new NotImplementedError(
    'checkVictory — tie-for-the-win semantics unconfirmed',
    'GDD.md §1 / docs/OPEN_QUESTIONS.md Q3',
  );
}
