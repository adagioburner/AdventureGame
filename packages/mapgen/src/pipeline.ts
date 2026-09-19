import { validateRuleset, type Ruleset } from '@adventure/config';
import { createRng, type GameMap, type Seed } from '@adventure/core';
import type { RemotenessScorer } from '@adventure/sim';
import { GENERATION_PIPELINE } from './steps/index.ts';
import { GenerationRejected, type GenerationContext, type MapDraft } from './types.ts';

export interface GenerateMapOptions {
  readonly seed: Seed;
  readonly ruleset: Ruleset;
  /** Injected because the scoring rule is still open — OPEN_QUESTIONS Q1. */
  readonly remotenessScorer: () => RemotenessScorer;
}

export class MapGenerationFailed extends Error {
  readonly attempts: number;
  readonly lastReason: string;
  constructor(attempts: number, lastReason: string) {
    super(`Map generation failed after ${attempts} attempts; last rejection: ${lastReason}`);
    this.name = 'MapGenerationFailed';
    this.attempts = attempts;
    this.lastReason = lastReason;
  }
}

/**
 * Run §2.1 end to end, regenerating on rejection.
 *
 * [SOURCE §1.3] One `Rng`, created once here from `seed`, is threaded through
 * every step **and every retry** — a rejected attempt advances the stream
 * rather than replaying it, so the whole generation including its retries is
 * still an exact function of `(seed, ruleset)`, as debugging, replays and the
 * balancing harness require.
 *
 * `MAX_GENERATION_ATTEMPTS` is an engineering safety valve, not a design value:
 * GDD.md says "reject and regenerate the whole map" with no bound, and an
 * unbounded loop on a pathological ruleset would simply hang.
 */
export function generateMap(options: GenerateMapOptions): GameMap {
  validateRuleset(options.ruleset);

  const rng = createRng(options.seed);
  const context: GenerationContext = {
    ruleset: options.ruleset,
    rng,
    seed: options.seed,
    remotenessScorer: options.remotenessScorer,
  };

  const maxAttempts = options.ruleset.engineering.MAX_GENERATION_ATTEMPTS;
  let lastReason = 'none';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const draft = emptyDraft();
    try {
      for (const step of GENERATION_PIPELINE) step.run(draft, context);
      return sealMap(draft, context, attempt);
    } catch (error) {
      if (error instanceof GenerationRejected) {
        lastReason = `${error.reason} at ${error.step}`;
        continue;
      }
      throw error;
    }
  }

  throw new MapGenerationFailed(maxAttempts, lastReason);
}

function emptyDraft(): MapDraft {
  return {
    positions: [],
    edges: [],
    terrain: [],
    adjacency: [],
    poiNodes: [],
    remoteness: new Map(),
    valleyNodes: new Set(),
    assignments: [],
  };
}

/**
 * Freeze a finished draft into the immutable `GameMap` the rest of the system
 * shares — including, per §1's no-hidden-information rule, with every client.
 */
function sealMap(_draft: MapDraft, _context: GenerationContext, _attempts: number): GameMap {
  throw new Error('sealMap: implement alongside the pipeline steps (GDD.md §2.1)');
}
