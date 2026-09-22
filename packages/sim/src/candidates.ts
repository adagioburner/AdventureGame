import type { GameConfig } from '@adventure/config';
import { dijkstra, type MapGraph, type NodeId, type Rng } from '@adventure/core';

/**
 * THE shared kernel.
 *
 * [SOURCE §1.2] §5.1: "repeatedly move to one of the `CLOSE_CANDIDATE_COUNT`
 * closest unvisited POIs (chosen at random among them)".
 * [SOURCE §5, chat] §9: "Rollout/simulation policy: choose a random target
 * among the `CLOSE_CANDIDATE_COUNT` closest POIs, using the same
 * weighted-terrain-cost random-walk code as §5.1."
 *
 * Both callers are the same two operations — rank eligible POIs by weighted
 * terrain cost, then pick uniformly among the nearest K — so they are written
 * once, here, and `remoteness.ts` and `rollout.ts` are thin wrappers over this
 * file and `walk.ts`. There is deliberately no second implementation of either
 * step anywhere in the repo.
 *
 * What differs between the two callers is only (a) which POIs count as
 * eligible, (b) what "move to the target" means, and (c) when to stop. All
 * three are injected; see `WalkDriver` in `walk.ts`.
 */
export interface PoiCandidate {
  readonly node: NodeId;
  /** Weighted terrain cost from the walk's current position. */
  readonly cost: number;
}

/**
 * The `CLOSE_CANDIDATE_COUNT` cheapest eligible POIs from `from`, ascending by
 * cost. Fewer than K are returned when fewer remain eligible.
 *
 * One `dijkstra` from `from`, stopped once K eligible POIs have been settled.
 * Because that search settles in `(cost, node id)` order, the list comes out
 * ascending by cost with the lowest node id first among equal costs, and a
 * given `(seed, params)` always yields the identical walk.
 *
 * `from` itself counts when it is eligible, at cost 0. That only arises on the
 * first leg of a remoteness walk, whose random plains start may happen to be an
 * unvisited POI; the alternative — skipping it — would leave a POI the walk can
 * never return to, since §5.1 only ever moves *away* from where it stands.
 */
export function closestPoiCandidates(
  graph: MapGraph,
  from: NodeId,
  eligible: ReadonlySet<NodeId>,
  config: GameConfig,
): readonly PoiCandidate[] {
  const wanted = config.balancing.CLOSE_CANDIDATE_COUNT;
  if (wanted <= 0 || eligible.size === 0) return [];

  const found: PoiCandidate[] = [];
  dijkstra(graph, from, config, {
    stopWhen: (node, cost) => {
      if (eligible.has(node)) found.push({ node, cost });
      return found.length >= wanted;
    },
  });
  return found;
}

/**
 * Pick the walk's next target: uniformly at random among the K closest.
 * "chosen at random among them" — uniform, with no distance weighting, in both
 * §5.1 and §9. Returns `null` when nothing is eligible, which is how a walk
 * signals it has run out of targets.
 */
export function chooseWalkTarget(
  graph: MapGraph,
  from: NodeId,
  eligible: ReadonlySet<NodeId>,
  config: GameConfig,
  rng: Rng,
): PoiCandidate | null {
  const candidates = closestPoiCandidates(graph, from, eligible, config);
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}
