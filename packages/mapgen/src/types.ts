import type { GuardType, RewardKind, Ruleset, Terrain } from '@adventure/config';
import type { MapEdge, NodeId, Point, Rng, Seed } from '@adventure/core';
import type { RemotenessScorer } from '@adventure/sim';

/**
 * The mutable work-in-progress a generation attempt passes between steps.
 *
 * Mutable on purpose: §2.1 is an eight-stage pipeline over one artefact, and
 * rebuilding an immutable graph eight times per attempt (times up to
 * `MAX_GENERATION_ATTEMPTS`) buys nothing. The draft is sealed into an
 * immutable `GameMap` once, at the end.
 */
export interface MapDraft {
  positions: Point[];
  edges: MapEdge[];
  /** Indexed by node id. Written by step 4, rewritten by steps 5 and 6. */
  terrain: Terrain[];
  /** Indexed by node id; rebuilt whenever `edges` changes. */
  adjacency: NodeId[][];
  /** Chosen by step 7. */
  poiNodes: NodeId[];
  /** Filled by step 7 between POI placement and reward assignment. */
  remoteness: Map<NodeId, number>;
  /**
   * [SOURCE §1.3] Nodes converted by Carve Valleys (step 6), which "are
   * exempted from the Smooth step".
   *
   * Given the fixed order — one Smooth pass at step 5, Carve Valleys once at
   * step 6 — the Smooth exemption is already satisfied by the ordering alone.
   * The set is read by step 6's own regrowth, which may not take a carved node
   * back, and it keeps the exemption enforceable if a later pass is ever added;
   * the balancing harness reads it to tell carved plains from grown plains.
   */
  valleyNodes: Set<NodeId>;
  /** Assigned by step 7; parallel to `poiNodes` only after reward assignment. */
  assignments: PoiAssignment[];
}

/** A POI mid-assignment, before it is sealed into an immutable `Poi`. */
export interface PoiAssignment {
  readonly node: NodeId;
  readonly terrain: Terrain;
  /** The §4.2 row this POI belongs to. */
  readonly kind: RewardKind;
  readonly guardType: GuardType | null;
  /** Grows during §4.3 steps 2 and 3. */
  units: number;
  /** Set by §5.2 once units are final; `null` while the POI is unguarded. */
  guardStrength: number | null;
}

/** Everything a step may read. One `Rng`, threaded through all eight steps. */
export interface GenerationContext {
  readonly ruleset: Ruleset;
  /**
   * [SOURCE §1.3] "every one drawing from a single seeded PRNG so a map is
   * fully reproducible from `(seed, params)`". One instance, created once per
   * `generateMap` call and shared by every step *and* every retry — so a
   * rejected attempt advances the stream rather than repeating it, and the
   * whole generation, retries included, still replays exactly from the seed.
   */
  readonly rng: Rng;
  readonly seed: Seed;
  /** Injected so a scoring variant stays a one-liner; see OPEN_QUESTIONS Q1. */
  readonly remotenessScorer: () => RemotenessScorer;
}

/**
 * Why an attempt was thrown away. Only §2.1's own rejection reasons appear.
 *
 * `poi_quota_unsatisfiable` used to live here, for a terrain with more leaves
 * than its `POI_COUNT`. [SOURCE §3/§9, chat] settled that without a rejection:
 * surplus leaves become stamina POIs, so the case no longer aborts an attempt.
 */
export type RejectionReason = 'disconnected' | 'leaf_count_out_of_range' | 'terrain_share_unreachable';

export class GenerationRejected extends Error {
  readonly reason: RejectionReason;
  readonly step: string;
  constructor(reason: RejectionReason, step: string, detail: string) {
    super(`Map generation rejected at ${step}: ${reason} (${detail})`);
    this.name = 'GenerationRejected';
    this.reason = reason;
    this.step = step;
  }
}

/** One stage of §2.1. Steps mutate the draft or throw `GenerationRejected`. */
export interface GenerationStep {
  /** e.g. "3-prune"; matches the numbering in §2.1. */
  readonly id: string;
  /** Section this step implements, for error messages. */
  readonly gdd: string;
  run(draft: MapDraft, context: GenerationContext): void;
}
