import type { Ruleset } from '@adventure/config';
import { NotImplementedError, type Seed } from '@adventure/core';

/**
 * The balancing harness.
 *
 * [SOURCE §1.3] Reproducibility from `(seed, params)` is called for explicitly
 * "for debugging, replays, and **the balancing harness**", so this is a
 * first-class consumer of the engine, not a script. It runs headless, imports
 * the same packages the server does, and never touches the session or UI layers.
 *
 * What it is for, and which config rows it exists to tune:
 *
 *   - `COMPACTNESS_MAX` (§11, "tunable (play-test)") — distribution of region
 *     shapes across many seeds.
 *   - `REMOTENESS_SIMULATION_RUNS` (§5.1, "expected to change if 100 proves too
 *     imprecise or too slow") — variance of the remoteness field between runs
 *     at 50 / 100 / 200, against wall-clock cost. This is the measurement the
 *     GDD explicitly anticipates needing.
 *   - `REMOTENESS_WEIGHT` (§5.2) and `REMOTENESS_WEIGHT_FOR_DISTRIBUTION`
 *     (§4.3) — the resulting guard-strength and reward-stack distributions.
 *   - `MCTS_TIME_BUDGET_PER_MOVE` (§9) — AI strength against search time, once
 *     a tree policy exists.
 */
export interface MapGenerationReport {
  readonly seed: Seed;
  readonly attempts: number;
  readonly leafCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly terrainShares: Readonly<Record<'plains' | 'forest' | 'mountain', number>>;
  /** Per terrain, after Smooth and after Carve Valleys — the latter is expected to be worse. */
  readonly compactnessAfterSmooth: Readonly<Record<'plains' | 'forest' | 'mountain', number>>;
  readonly compactnessAfterValleys: Readonly<Record<'plains' | 'forest' | 'mountain', number>>;
  readonly remotenessHistogram: readonly number[];
  readonly goldUnitsTotal: number;
  readonly guardStrengthHistogram: readonly number[];
}

export interface BatchOptions {
  readonly ruleset: Ruleset;
  readonly seeds: readonly Seed[];
}

/** Generate many maps and report the distributions above. */
export function runMapBatch(_options: BatchOptions): readonly MapGenerationReport[] {
  throw new NotImplementedError('runMapBatch', 'GDD.md §1.3, §11');
}

/**
 * Play AI-vs-AI games to completion and report outcomes.
 *
 * The policies, evaluators and branch rules all exist now; what this waits on is
 * `search()`'s four-phase loop and `macroAdvanceToTarget`, not a design answer.
 */
export function runSelfPlayBatch(_options: BatchOptions): never {
  throw new NotImplementedError('runSelfPlayBatch — requires MCTS search()', 'GDD.md §9');
}
