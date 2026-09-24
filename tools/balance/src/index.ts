import { TERRAINS, type Ruleset, type Terrain } from '@adventure/config';
import {
  leafNodes,
  terrainCompactness,
  terrainNodes,
  totalGoldUnits,
  type GameMap,
  type NodeId,
  type Seed,
} from '@adventure/core';
import { generateMap, type MapDraft } from '@adventure/mapgen';
import { defaultRemotenessScorer } from '@adventure/sim';
import { draftAsGraph } from '@adventure/mapgen';

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
 *   - `MCTS_TIME_BUDGET_PER_MOVE` (§9) — AI strength against search time:
 *     `runSelfPlayBatch` in `selfplay.ts`.
 */
export interface MapGenerationReport {
  readonly seed: Seed;
  readonly attempts: number;
  readonly leafCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly terrainShares: Readonly<Record<Terrain, number>>;
  /**
   * Per terrain, after Smooth and after Carve Valleys — the latter is expected
   * to be worse. Each is the terrain's **worst** connected component, which is
   * the quantity §2.1 step 5 loops on (`meetsCompactnessTarget` asks every
   * component to be under `COMPACTNESS_MAX`, so the worst one is the test).
   */
  readonly compactnessAfterSmooth: Readonly<Record<Terrain, number>>;
  readonly compactnessAfterValleys: Readonly<Record<Terrain, number>>;
  /** Terrain shares as step 4 grew them, before step 6 carved plains into them. */
  readonly terrainSharesAfterSmooth: Readonly<Record<Terrain, number>>;
  readonly remotenessHistogram: readonly number[];
  readonly goldUnitsTotal: number;
  readonly guardStrengthHistogram: readonly number[];
  readonly poiCount: number;
  /** Nodes step 6 converted, which the sealed map does not carry. */
  readonly valleyNodes: readonly NodeId[];
}

/** Ten buckets over [0, 1]; the last one is closed so remoteness 1 lands in it. */
export const HISTOGRAM_BUCKETS = 10;

export interface GeneratedMapWithReport {
  readonly map: GameMap;
  readonly report: MapGenerationReport;
}

/**
 * Generate one map and measure it.
 *
 * The two compactness readings and `valleyNodes` cannot come from the finished
 * `GameMap` — one is taken between steps and the other is draft-only — so this
 * watches generation through `GenerationObserver` rather than adding generator
 * internals to the object every client receives (Q15).
 */
export function generateAndReport(seed: Seed, ruleset: Ruleset): GeneratedMapWithReport {
  let afterSmooth: Readonly<Record<Terrain, number>> = zeroPerTerrain();
  let sharesAfterSmooth: Readonly<Record<Terrain, number>> = zeroPerTerrain();
  let valleyNodes: NodeId[] = [];

  const map = generateMap({
    seed,
    ruleset,
    remotenessScorer: defaultRemotenessScorer,
    observer: {
      attemptStarted() {
        // A rejected attempt leaves stale readings behind; clear them so a
        // report always describes the attempt that actually produced the map.
        afterSmooth = zeroPerTerrain();
        sharesAfterSmooth = zeroPerTerrain();
        valleyNodes = [];
      },
      stepCompleted(step, draft: MapDraft) {
        if (step.id === '5-smooth') {
          afterSmooth = worstCompactness(draft);
          sharesAfterSmooth = sharesOf(draft);
        }
        if (step.id === '6-carve-valleys') valleyNodes = [...draft.valleyNodes].sort((a, b) => a - b);
      },
    },
  });

  // Every POI whose §4.2 row gives it a guard, **including the ones §5.2 capped
  // to 0**: those seal with `guard: null` and would otherwise vanish from the
  // histogram, hiding exactly the case the formula's low end is about.
  const guards = map.pois.flatMap((poi) =>
    poi.group.guard === null ? [] : [poi.guard === null ? 0 : poi.guard.strength],
  );
  const guardMax = ruleset.config.pois.GUARD_STRENGTH.max;

  return {
    map,
    report: {
      seed,
      attempts: map.attempts,
      leafCount: leafNodes(map.graph).length,
      nodeCount: map.graph.nodes.length,
      edgeCount: map.graph.edges.length,
      poiCount: map.pois.length,
      terrainShares: sharesOfMap(map),
      terrainSharesAfterSmooth: sharesAfterSmooth,
      compactnessAfterSmooth: afterSmooth,
      compactnessAfterValleys: worstCompactnessOfMap(map),
      remotenessHistogram: histogram(
        map.pois.map((poi) => poi.remoteness),
        HISTOGRAM_BUCKETS,
        0,
        1,
      ),
      goldUnitsTotal: totalGoldUnits(map),
      guardStrengthHistogram: histogram(guards, guardMax + 1, 0, guardMax),
      valleyNodes,
    },
  };
}

export interface BatchOptions {
  readonly ruleset: Ruleset;
  readonly seeds: readonly Seed[];
}

/** Generate many maps and report the distributions above. */
export function runMapBatch(options: BatchOptions): readonly MapGenerationReport[] {
  return options.seeds.map((seed) => generateAndReport(seed, options.ruleset).report);
}

/** Counts per bucket over `[low, high]`; the top bucket is closed at `high`. */
export function histogram(values: readonly number[], buckets: number, low: number, high: number): number[] {
  const counts = new Array<number>(buckets).fill(0);
  if (buckets <= 0 || high <= low) return counts;
  for (const value of values) {
    const scaled = Math.floor(((value - low) / (high - low)) * buckets);
    const index = Math.min(buckets - 1, Math.max(0, scaled));
    counts[index] = (counts[index] as number) + 1;
  }
  return counts;
}

function zeroPerTerrain(): Record<Terrain, number> {
  return { plains: 0, forest: 0, mountain: 0 };
}

function worstCompactness(draft: MapDraft): Record<Terrain, number> {
  const graph = draftAsGraph(draft);
  const out = zeroPerTerrain();
  for (const terrain of TERRAINS) out[terrain] = Math.max(0, ...terrainCompactness(graph, terrain));
  return out;
}

function worstCompactnessOfMap(map: GameMap): Record<Terrain, number> {
  const out = zeroPerTerrain();
  for (const terrain of TERRAINS) out[terrain] = Math.max(0, ...terrainCompactness(map.graph, terrain));
  return out;
}

function sharesOf(draft: MapDraft): Record<Terrain, number> {
  const graph = draftAsGraph(draft);
  const out = zeroPerTerrain();
  const total = graph.nodes.length || 1;
  for (const terrain of TERRAINS) out[terrain] = terrainNodes(graph, terrain).size / total;
  return out;
}

function sharesOfMap(map: GameMap): Record<Terrain, number> {
  const out = zeroPerTerrain();
  const total = map.graph.nodes.length || 1;
  for (const terrain of TERRAINS) out[terrain] = terrainNodes(map.graph, terrain).size / total;
  return out;
}
