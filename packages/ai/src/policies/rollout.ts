import type { GameConfig } from '@adventure/config';
import type { DiceSource, Rng } from '@adventure/core';
import { runRollout, type RestRule, type RolloutCursor, type RolloutTermination } from '@adventure/sim';
import type { RolloutPolicy } from '../types.ts';

export interface ClosestPoiRolloutSettings {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly restRule: RestRule;
}

/**
 * [SOURCE §5, chat] The specified rollout policy: "choose a random target among
 * the `CLOSE_CANDIDATE_COUNT` closest POIs, using the same
 * weighted-terrain-cost random-walk code as §5.1".
 *
 * The body is a thin wrapper over `@adventure/sim`'s `runRollout`; the target
 * choosing itself is `chooseWalkTarget`, shared verbatim with remoteness
 * scoring. Nothing is reimplemented here.
 */
export function closestPoiRolloutPolicy(settings: ClosestPoiRolloutSettings): RolloutPolicy {
  return {
    name: 'closest-poi-random',
    run(from: RolloutCursor, rng: Rng, dice: DiceSource): RolloutCursor {
      return runRollout(from, { ...settings, rng, dice });
    },
  };
}
