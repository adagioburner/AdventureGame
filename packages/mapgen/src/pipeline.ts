import { validateRuleset, type Ruleset } from '@adventure/config';
import {
  asNodeId,
  createRng,
  type GameMap,
  type Guard,
  type MapGraph,
  type NodeId,
  type Poi,
  type Seed,
} from '@adventure/core';
import type { RemotenessScorer } from '@adventure/sim';
import { draftAsGraph } from './graphops.ts';
import { GENERATION_PIPELINE } from './steps/index.ts';
import { GenerationRejected, type GenerationContext, type GenerationStep, type MapDraft } from './types.ts';

/**
 * Hooks for a tool that wants to watch generation happen.
 *
 * The balancing harness needs two things the finished `GameMap` cannot carry:
 * measurements taken *between* steps (§11 wants compactness both after Smooth
 * and after Carve Valleys), and the draft-only `valleyNodes` set. Handing them
 * out here keeps them out of `GameMap`, which every client receives (Q15) and
 * which is the game's data rather than the generator's.
 *
 * Nothing in play passes an observer; it is diagnostics only, and it must not
 * touch the draft it is shown.
 */
export interface GenerationObserver {
  attemptStarted?(attempt: number): void;
  stepCompleted?(step: GenerationStep, draft: MapDraft): void;
  attemptRejected?(rejection: GenerationRejected): void;
}

export interface GenerateMapOptions {
  readonly seed: Seed;
  readonly ruleset: Ruleset;
  /** Injected so a scoring variant stays a one-liner; see OPEN_QUESTIONS Q1. */
  readonly remotenessScorer: () => RemotenessScorer;
  /** Diagnostics for `tools/balance`; see `GenerationObserver`. */
  readonly observer?: GenerationObserver;
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
    options.observer?.attemptStarted?.(attempt);
    try {
      for (const step of GENERATION_PIPELINE) {
        step.run(draft, context);
        options.observer?.stepCompleted?.(step, draft);
      }
      return sealMap(draft, context, attempt);
    } catch (error) {
      if (error instanceof GenerationRejected) {
        options.observer?.attemptRejected?.(error);
        lastReason = `${error.reason} at ${error.step}`;
        continue;
      }
      throw error;
    }
  }

  throw new MapGenerationFailed(maxAttempts, lastReason);
}

/**
 * A draft before step 1 has run. Exported because every step is testable on its
 * own, and a test needs somewhere to start.
 */
export function emptyDraft(): MapDraft {
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
 *
 * Two things happen here rather than in a step, because both are about the
 * finished article rather than about generation:
 *
 *  - **A guard strength of 0 seals as no guard at all.** [SOURCE §5.2, chat]
 *    "1 gold with maximum remoteness is unguarded", and 0 is what the capped
 *    formula returns for it. The POI keeps its §4.2 row in `group`, so the
 *    table still reconciles; what it loses is the `Guard` a player would have
 *    to roll against.
 *  - **`artVariant` is drawn here**, last, from the same stream, so it is a
 *    stable function of `(seed, ruleset)` without displacing any draw that
 *    decides an actual rule.
 *
 * Everything is plain JSON — arrays, objects, numbers, strings — apart from
 * `poiByNode`, which is rebuilt on arrival. Q15 sends this whole object to
 * every client, so nothing here may be a `Set`, a class instance or a function.
 */
function sealMap(draft: MapDraft, context: GenerationContext, attempts: number): GameMap {
  const graph: MapGraph = draftAsGraph(draft);
  const pois: Poi[] = draft.assignments.map((assignment) => ({
    node: assignment.node,
    terrain: assignment.terrain,
    reward: { kind: assignment.kind, units: assignment.units },
    guard: sealGuard(assignment.guardType, assignment.guardStrength),
    remoteness: remotenessOf(draft, assignment.node),
    group: { kind: assignment.kind, guard: assignment.guardType },
    artVariant: context.rng.nextUint32(),
  }));

  const poiByNode = new Map<NodeId, number>();
  pois.forEach((poi, index) => poiByNode.set(poi.node, index));

  return {
    seed: context.seed,
    ruleset: context.ruleset,
    graph,
    pois,
    poiByNode,
    attempts,
  };
}

function sealGuard(type: Guard['type'] | null, strength: number | null): Guard | null {
  if (type === null || strength === null || strength <= 0) return null;
  return { type, strength };
}

function remotenessOf(draft: MapDraft, node: NodeId): number {
  const score = draft.remoteness.get(node);
  if (score === undefined) throw new RangeError(`no remoteness score for POI node ${node}`);
  return score;
}

/**
 * Rebuild the lookup `sealMap` dropped on the way through `JSON.stringify`.
 *
 * Q15 ships the sealed map to every client as JSON, and a `Map` does not
 * survive that. This is the other half of the round trip, so a client, a replay
 * and the balancing harness all reconstruct the identical object rather than
 * each inventing its own index.
 */
export function reviveGameMap(parsed: Omit<GameMap, 'poiByNode'> & { poiByNode?: unknown }): GameMap {
  const poiByNode = new Map<NodeId, number>();
  parsed.pois.forEach((poi, index) => poiByNode.set(asNodeId(poi.node), index));
  return {
    seed: parsed.seed,
    ruleset: parsed.ruleset,
    graph: parsed.graph,
    pois: parsed.pois,
    poiByNode,
    attempts: parsed.attempts,
  };
}
