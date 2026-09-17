import type { GameConfig } from '@adventure/config';
import type { MapGraph, NodeId, Rng } from '@adventure/core';
import { runWalk, type WalkDriver, type WalkVisit } from './walk.ts';
import type { PoiCandidate } from './candidates.ts';

/**
 * [SOURCE §1.2] §5.1: "Computed via simulated random walks: start at a random
 * plains position, repeatedly move to one of the `CLOSE_CANDIDATE_COUNT`
 * closest unvisited POIs (chosen at random among them), until every POI has
 * been visited once per walk. [...] Run `REMOTENESS_SIMULATION_RUNS` walks,
 * normalize the resulting per-POI scores to [0, 1]."
 *
 * [SOURCE §5.1, chat] The per-POI score, which §5.1 itself left unstated: "a
 * POI's score is the sum of the length of the segment that lead to it during
 * the walk, and the segment that lead out of it. For the first POI it's double
 * the length of the first segment, and for the last one it's double the length
 * of the last segment."
 *
 * A scorer therefore needs walk boundaries, not just a stream of arrivals —
 * hence `beginWalk` / `endWalk`, which is what the "first POI" and "last POI"
 * cases are defined against.
 */
export interface RemotenessScorer {
  /** Start of one of the `REMOTENESS_SIMULATION_RUNS` walks. */
  beginWalk(): void;
  /** Called once per POI arrival, in walk order. */
  record(visit: WalkVisit): void;
  /** End of a walk — where the "last POI" rule is applied. */
  endWalk(): void;
  /** Raw (un-normalised) score per POI, after every walk has finished. */
  finish(): ReadonlyMap<NodeId, number>;
}

/**
 * The scorer specified above.
 *
 * For a walk that visits POIs `P1 … Pn` over segments `s1 … sn`, where `si` is
 * the leg that arrived at `Pi` (so `s1` is the leg from the random plains
 * start):
 *
 *   score(P1) = 2 × s1                      // first POI
 *   score(Pi) = si + s(i+1)   for 1 < i < n // segment in + segment out
 *   score(Pn) = 2 × sn                      // last POI, no segment out
 *
 * A single-POI walk hits both boundary cases and scores `2 × s1` once.
 *
 * Scores accumulate as a **sum** across all walks rather than a mean. With a
 * fixed run count the two differ by a constant factor, and min-max
 * normalisation to [0, 1] is invariant under that, so the distinction cannot
 * affect any downstream rule.
 *
 * One wrinkle worth knowing about, flagged to the designer rather than
 * resolved: "double the length of the first segment" reads literally as `2 × s1`
 * where `s1` is the leg in from the random plains start, which is what is
 * implemented. It could instead have meant the first *inter-POI* segment
 * (`P1 → P2`), discarding the start leg — that reading makes both boundary
 * cases symmetric ("missing one neighbour, so double the one you have"). The
 * two differ only in the first POI's score, so roughly 1-2% of a POI's total
 * over 100 runs. See OPEN_QUESTIONS Q1.
 */
export function segmentSumRemotenessScorer(): RemotenessScorer {
  const totals = new Map<NodeId, number>();
  let walk: WalkVisit[] = [];

  return {
    beginWalk() {
      walk = [];
    },
    record(visit) {
      walk.push(visit);
    },
    endWalk() {
      const lastIndex = walk.length - 1;
      for (let i = 0; i <= lastIndex; i++) {
        const arrival = walk[i];
        if (arrival === undefined) continue;
        const departure = walk[i + 1];
        const score =
          i === 0 || departure === undefined
            ? 2 * arrival.legCost // first POI, or last POI (no segment out)
            : arrival.legCost + departure.legCost;
        totals.set(arrival.target, (totals.get(arrival.target) ?? 0) + score);
      }
      walk = [];
    },
    finish: () => totals,
  };
}

/** The scorer §5.1 calls for. Named separately so a variant stays a one-liner. */
export const defaultRemotenessScorer = segmentSumRemotenessScorer;

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
    scorer.beginWalk();
    runWalk(graph, start, remotenessDriver((visit) => scorer.record(visit)), config, rng, poiNodes.length + 1);
    scorer.endWalk();
  }

  return normalizeToUnitRange(scorer.finish());
}
