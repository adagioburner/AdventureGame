import type { GameConfig } from '@adventure/config';
import type { MapGraph, NodeId, Rng } from '@adventure/core';
import { chooseWalkTarget, type PoiCandidate } from './candidates.ts';

/** One leg of a walk: the POI reached and what it cost to get there. */
export interface WalkVisit {
  readonly target: NodeId;
  /** Weighted terrain cost of this leg alone. */
  readonly legCost: number;
  /** Weighted terrain cost of the whole walk up to and including this leg. */
  readonly cumulativeCost: number;
  /** 0-based order of arrival within this walk. */
  readonly order: number;
}

/**
 * The three things that differ between the remoteness walk (§5.1) and the MCTS
 * rollout (§9). Everything else — target ranking, the uniform pick among the K
 * closest, the loop — is shared.
 */
export interface WalkDriver<TCursor> {
  /** POIs still worth targeting from `cursor`. §5.1: unvisited. §9: unclaimed. */
  eligible(cursor: TCursor): ReadonlySet<NodeId>;
  /** Where the walker currently is. */
  position(cursor: TCursor): NodeId;
  /**
   * Advance to `target`. §5.1 moves straight there and charges the path cost;
   * §9 instead plays real turns through `applyAction`, so a leg may take
   * several turns and may be cut short. Returning `null` ends the walk.
   */
  advance(cursor: TCursor, target: PoiCandidate): TCursor | null;
  /** True when this walk is finished. See `RolloutTermination` for the §9 case. */
  done(cursor: TCursor): boolean;
}

export interface WalkResult<TCursor> {
  readonly cursor: TCursor;
  readonly visits: readonly WalkVisit[];
  readonly totalCost: number;
}

/**
 * The shared random-walk loop.
 *
 * `maxLegs` is an implementation-level guard against a driver that never
 * terminates; it is not a design value and must be set high enough never to
 * bind in normal operation.
 */
export function runWalk<TCursor>(
  graph: MapGraph,
  start: TCursor,
  driver: WalkDriver<TCursor>,
  config: GameConfig,
  rng: Rng,
  maxLegs: number,
): WalkResult<TCursor> {
  const visits: WalkVisit[] = [];
  let cursor = start;
  let cumulativeCost = 0;

  for (let leg = 0; leg < maxLegs && !driver.done(cursor); leg++) {
    const target = chooseWalkTarget(graph, driver.position(cursor), driver.eligible(cursor), config, rng);
    if (target === null) break;
    const advanced = driver.advance(cursor, target);
    if (advanced === null) break;
    cursor = advanced;
    cumulativeCost += target.cost;
    visits.push({ target: target.node, legCost: target.cost, cumulativeCost, order: visits.length });
  }

  return { cursor, visits, totalCost: cumulativeCost };
}
