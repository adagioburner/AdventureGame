import { NotImplementedError } from '@adventure/core';
import type { RolloutPolicy } from '../types.ts';

/**
 * [SOURCE §5, chat] The specified rollout policy: "choose a random target among
 * the `CLOSE_CANDIDATE_COUNT` closest POIs, using the same
 * weighted-terrain-cost random-walk code as §5.1".
 *
 * The body is a thin wrapper over `@adventure/sim`'s `runRollout`; the target
 * choosing itself is `chooseWalkTarget`, shared verbatim with remoteness
 * scoring. Nothing is reimplemented here.
 */
export function closestPoiRolloutPolicy(): RolloutPolicy {
  return {
    name: 'closest-poi-random',
    run() {
      throw new NotImplementedError('closestPoiRolloutPolicy.run', 'GDD.md §9 (via @adventure/sim runRollout)');
    },
  };
}
