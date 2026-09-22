import { TERRAINS, type GameConfig, type Terrain } from '@adventure/config';
import { asNodeId, dijkstra, isLeaf, type NodeId } from '@adventure/core';
import { draftAsGraph } from '../graphops.ts';
import { assignGuardStrengths } from '../rewards/guards.ts';
import { assignRewards } from '../rewards/assign.ts';
import { computeRemoteness } from '@adventure/sim';
import {
  GenerationRejected,
  type GenerationContext,
  type GenerationStep,
  type MapDraft,
  type PoiAssignment,
} from '../types.ts';

/**
 * §2.1 step 7 — "Place POIs: node selection and reward assignment; see §3 and §4."
 *
 * This is the one composite step. Its internal order is forced by the data
 * dependencies [INFERRED §1.3/§4.3]:
 *
 *   7a. Select POI nodes (§3).
 *   7b. Compute remoteness over those nodes (§5.1) — depends only on POI
 *       *positions*, never on their rewards, which is why it can run here.
 *   7c. Assign kinds and distribute units (§4.3), which consumes remoteness.
 *   7d. Assign guard strengths (§5.2), which consumes both remoteness and the
 *       final gold amounts from 7c.
 */
export const placePoisStep: GenerationStep = {
  id: '7-place-pois',
  gdd: 'GDD.md §2.1 step 7, §3, §4, §5',
  run(draft: MapDraft, context: GenerationContext): void {
    const { ruleset, rng } = context;
    const graph = draftAsGraph(draft);

    // 7a. Selection, terrain by terrain, plus the surplus leaves that fall
    // outside §4.2 and are assigned here rather than by §4.3.
    const chosen: NodeId[] = [];
    const surplus: PoiAssignment[] = [];

    for (const terrain of TERRAINS) {
      const quota = ruleset.config.pois.POI_COUNT[terrain];
      const available = nodesOfTerrain(draft, terrain);

      // §2.1's shares are approximate and a region can be sealed off while
      // growing (see step 4), so a terrain can in principle come out smaller
      // than its §4.2 quota. That map cannot satisfy §4.2 at all, and the
      // answer §2.1 gives for a map that cannot be finished is to throw the
      // attempt away and generate another.
      if (available.length < quota) {
        throw new GenerationRejected(
          'terrain_share_unreachable',
          '7-place-pois',
          `${terrain} has ${available.length} nodes but §4.2 needs ${quota} POIs`,
        );
      }

      // §3: "leaf nodes are assigned POI status first". Shuffled so that which
      // leaves fall inside the §4.2 quota and which spill over is a draw from
      // the map's own stream rather than an artefact of node numbering.
      const leaves = rng.shuffle(available.filter((node) => isLeaf(graph, node)));
      const overflow = overflowLeafPois(draft, terrain, leaves, quota);
      const forced = leaves.slice(0, Math.min(quota, leaves.length));

      const filler = DEFAULT_POI_PLACEMENT.select(
        draft,
        terrain,
        forced,
        Math.max(0, quota - forced.length),
        ruleset.config,
      );
      chosen.push(...forced, ...filler, ...overflow);

      for (const node of overflow) {
        surplus.push({
          node,
          terrain,
          kind: 'stamina',
          guardType: null,
          units: ruleset.config.pois.OVERFLOW_LEAF_STAMINA_UNITS,
          guardStrength: null,
        });
      }
    }

    draft.poiNodes = chosen.slice().sort((left, right) => left - right);
    draft.assignments = surplus;

    // 7b. §5.1 over every POI, the surplus stamina ones included: they are
    // ordinary POIs and the walk visits them like any other.
    draft.remoteness = new Map(
      computeRemoteness(graph, draft.poiNodes, ruleset.config, rng, context.remotenessScorer()),
    );

    // 7c and 7d.
    assignRewards(draft, ruleset, rng);
    assignGuardStrengths(draft.assignments, draft.remoteness, ruleset.config);
  },
};

/**
 * §3 — "POI placement: distributed randomly at approximately equal distances
 * from each other; every leaf node of the graph must be a POI (no dead ends);
 * leaf nodes are assigned POI status first, remaining POIs distributed randomly
 * among the rest." Counts per terrain come from `POI_COUNT` (25/20/15).
 *
 * [SOURCE §3, chat] Kept as a strategy seam so that swapping the rule stays a
 * one-liner: [SOURCE chat, 2026-09-22] Andrei settled it (Q23) on farthest-point
 * sampling — "we'll switch if that looks bad, which I doubt" — so that is the
 * one implementation here, and the balancing harness's SVG is where it would
 * be seen to look bad.
 */
export interface PoiPlacementStrategy {
  readonly name: string;
  /** POI nodes for one terrain, excluding the leaves already forced in. */
  select(
    draft: MapDraft,
    terrain: Terrain,
    forced: readonly NodeId[],
    count: number,
    config: GameConfig,
  ): readonly NodeId[];
}

/**
 * Farthest-point sampling over the weighted terrain cost — the same distance
 * metric as everything else (§1.2).
 *
 * Each pick is the candidate whose nearest already-chosen POI is furthest away,
 * which is what turns "approximately equal distances" into a procedure: the
 * spacing it produces is within a factor of two of the best possible for that
 * many points. Distances run over the *whole* graph rather than the terrain
 * alone, so a plains POI just across a border still pushes a forest POI away
 * from it. The forced leaves seed the set, so filler POIs are placed in the
 * gaps the leaves leave rather than ignoring them.
 */
export const farthestPointPlacement: PoiPlacementStrategy = {
  name: 'farthest-point',
  select(
    draft: MapDraft,
    terrain: Terrain,
    forced: readonly NodeId[],
    count: number,
    config: GameConfig,
  ): readonly NodeId[] {
    if (count <= 0) return [];
    const graph = draftAsGraph(draft);

    const candidates = nodesOfTerrain(draft, terrain).filter((node) => !forced.includes(node));
    if (candidates.length === 0) return [];

    const nearest = new Array<number>(draft.positions.length).fill(Number.POSITIVE_INFINITY);
    const seeds = forced.length > 0 ? forced : [candidates[0] as NodeId];
    for (const seed of seeds) absorb(nearest, dijkstra(graph, seed, config).costs);

    const chosen: NodeId[] = [];
    const taken = new Set<NodeId>(forced);
    for (let picked = 0; picked < count; picked++) {
      let best: NodeId | null = null;
      let bestDistance = -1;
      for (const candidate of candidates) {
        if (taken.has(candidate)) continue;
        const distance = nearest[candidate] as number;
        // Ties break to the lowest node id, which the ascending candidate
        // order gives for free.
        if (distance > bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      if (best === null) break;
      taken.add(best);
      chosen.push(best);
      absorb(nearest, dijkstra(graph, best, config).costs);
    }
    return chosen;
  },
};

export const DEFAULT_POI_PLACEMENT: PoiPlacementStrategy = farthestPointPlacement;

function absorb(nearest: number[], costs: readonly number[]): void {
  for (let index = 0; index < nearest.length; index++) {
    const cost = costs[index] ?? Number.POSITIVE_INFINITY;
    if (cost < (nearest[index] as number)) nearest[index] = cost;
  }
}

function nodesOfTerrain(draft: MapDraft, terrain: Terrain): NodeId[] {
  const nodes: NodeId[] = [];
  for (let index = 0; index < draft.terrain.length; index++) {
    if (draft.terrain[index] === terrain) nodes.push(asNodeId(index));
  }
  return nodes;
}

/**
 * Surplus leaves.
 *
 * §3 forces every leaf to be a POI, but leaf count (30–45) is not apportioned
 * across terrains in the 25/20/15 proportions, so a terrain can legally hold
 * more leaves than its quota — e.g. 17 leaves in the mountains against a quota
 * of 15.
 *
 * [SOURCE §3/§9, chat] "Fill the extra leaf nodes with stamina rewards." So the
 * §4.2 quota is satisfied exactly as written and the surplus leaves become
 * *additional* POIs outside the table, each carrying `stamina`. Two things
 * follow:
 *
 *  - a map can hold slightly more than 60 POIs, and total POI count is no
 *    longer fixed;
 *  - `stamina`, which appears in §4.1's seven kinds but in no §4.2 row, finally
 *    has a home — [SOURCE §4.2, chat] "proceed now without stamina, add later
 *    as a config edit", and this is the one place it is placed meanwhile.
 *
 * These POIs are unguarded: §4.2 is what decides guarding (v1 guards gold only),
 * and they are not in it. They are ordinary POIs otherwise — the remoteness
 * walk visits them and the AI targets them like any other.
 *
 * [SOURCE §9a, chat] One stamina unit each — `OVERFLOW_LEAF_STAMINA_UNITS`.
 *
 * Which leaves spill over is the caller's draw: it passes them already
 * shuffled, and this takes everything past the quota.
 */
export function overflowLeafPois(
  _draft: MapDraft,
  _terrain: Terrain,
  leaves: readonly NodeId[],
  quota: number,
): readonly NodeId[] {
  return leaves.length <= quota ? [] : leaves.slice(quota);
}
