import type { GameConfig } from '@adventure/config';
import type { DiceSource, Rng } from '@adventure/core';
import { runRollout, type RestRule, type RolloutCursor, type RolloutTermination } from '@adventure/sim';
import type { RolloutPolicy } from '../types.ts';

export interface AttractivePoiRolloutSettings {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly restRule: RestRule;
}

/**
 * [SOURCE §9, review] The specified rollout policy (Q65): each player "will
 * choose randomly among the same set of POI" the search branches over, the
 * `ATTRACTIVE_POIS_PER_KIND` most attractive of each kind for that player.
 *
 * The body is a thin wrapper over `@adventure/sim`'s `runRollout`; the target
 * choosing itself is `attractiveTargets`, shared verbatim with the search
 * tree. Nothing is reimplemented here.
 */
export function attractivePoiRolloutPolicy(settings: AttractivePoiRolloutSettings): RolloutPolicy {
  return {
    name: 'attractive-poi-random',
    run(from: RolloutCursor, rng: Rng, dice: DiceSource): RolloutCursor {
      return runRollout(from, { ...settings, rng, dice });
    },
  };
}
