import type { GameConfig } from '@adventure/config';
import { NotImplementedError, type MapGraph, type NodeId, type Rng } from '@adventure/core';
import { runWalk, type WalkDriver, type WalkVisit } from './walk.ts';
import type { PoiCandidate } from './candidates.ts';

/**
 * [SOURCE §1.2] §5.1: "Computed via simulated random walks: start at a random
 * plains position, repeatedly move to one of the `CLOSE_CANDIDATE_COUNT`
 * closest unvisited POIs (chosen at random among them), until every POI has
 * been visited once per walk. [...] Run `REMOTENESS_SIMULATION_RUNS` walks,
 * normalize the resulting per-POI scores to [0, 1]."
 *
 * Everything in that paragraph is implemented below **except one thing**: what
 * a POI's per-walk score actually *is*. The GDD fixes the walk, the metric and
 * the normalisation, but never says whether a POI scores the cumulative walk
 * cost when it was first reached, the cost of the single leg that reached it,
 * or its ordinal position in the visit sequence. Those give materially
 * different remoteness fields, and remoteness feeds both guard strength (§5.2)
 * and reward stacking (§4.3), so it is not a detail.
 *
 * Hence: injected, with no default shipped. See OPEN_QUESTIONS Q1.
 */
export interface RemotenessScorer {
  /** Called once per POI arrival, across all `REMOTENESS_SIMULATION_RUNS` walks. */
  record(visit: WalkVisit): void;
  /** Raw (un-normalised) score per POI, after every walk has finished. */
  finish(): ReadonlyMap<NodeId, number>;
}

/**
 * Deliberately not implemented — picking one of the three readings above would
 * be inventing a design decision. Supply a scorer explicitly once the designer
 * has answered Q1.
 */
export function defaultRemotenessScorer(): RemotenessScorer {
  throw new NotImplementedError(
    'defaultRemotenessScorer — the per-POI score definition is unspecified',
    'GDD.md §5.1 / docs/OPEN_QUESTIONS.md Q1',
  );
}

/** Cursor for the remoteness walk: where we are and what we have seen. */
interface RemotenessCursor {
  readonly at: NodeId;
  readonly unvisited: ReadonlySet<NodeId>;
}

function remotenessDriver(onVisit: (visit: WalkVisit) => void): WalkDriver<RemotenessCursor> {
  let order = 0;
  let cumulative = 0;
  return {
    eligible: (cursor) => cursor.unvisited,
    position: (cursor) => cursor.at,
    // §5.1's walk is pure geometry: it moves straight to the chosen POI and
    // charges the weighted path cost. Turn structure, stamina and skills play
    // no part here — that is what distinguishes it from the §9 rollout, which
    // shares the target chooser but advances through the real rules.
    advance: (cursor, target: PoiCandidate) => {
      cumulative += target.cost;
      onVisit({ target: target.node, legCost: target.cost, cumulativeCost: cumulative, order: order++ });
      const unvisited = new Set(cursor.unvisited);
      unvisited.delete(target.node);
      return { at: target.node, unvisited };
    },
    done: (cursor) => cursor.unvisited.size === 0,
  };
}

/**
 * [SOURCE §1.2] "normalize the resulting per-POI scores to [0, 1]".
 * Min-max across the map's POIs. Degenerate all-equal input maps everything to
 * 0; it cannot occur on a real map and no rule depends on the choice.
 */
export function normalizeToUnitRange(raw: ReadonlyMap<NodeId, number>): ReadonlyMap<NodeId, number> {
  const values = [...raw.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const normalized = new Map<NodeId, number>();
  for (const [node, value] of raw) normalized.set(node, span === 0 ? 0 : (value - min) / span);
  return normalized;
}

/**
 * Run `REMOTENESS_SIMULATION_RUNS` walks and return normalised remoteness per
 * POI. Called from inside §2.1 step 7, after POI *placement* and before reward
 * assignment, because §4.3 step 3 consumes remoteness — [INFERRED §1.3/§4.3],
 * and consistent with remoteness depending only on POI positions, never on
 * their rewards.
 */
export function computeRemoteness(
  graph: MapGraph,
  poiNodes: readonly NodeId[],
  config: GameConfig,
  rng: Rng,
  scorer: RemotenessScorer,
): ReadonlyMap<NodeId, number> {
  const plainsNodes = graph.nodes.filter((node) => node.terrain === 'plains').map((node) => node.id);
  if (plainsNodes.length === 0) throw new RangeError('no plains node to start a remoteness walk from');

  for (let run = 0; run < config.balancing.REMOTENESS_SIMULATION_RUNS; run++) {
    // [SOURCE §1.2] "start at a random plains position" — any plains node, not
    // necessarily a POI.
    const start: RemotenessCursor = { at: rng.pick(plainsNodes), unvisited: new Set(poiNodes) };
    runWalk(graph, start, remotenessDriver((visit) => scorer.record(visit)), config, rng, poiNodes.length + 1);
  }

  return normalizeToUnitRange(scorer.finish());
}
