import { SKILL_KINDS, TERRAINS, type GameConfig, type PerTerrain } from '@adventure/config';
import {
  refreshAllowance,
  routeTable,
  type GameState,
  type NodeId,
  type PlayerState,
  type PlayerStats,
  type Rng,
} from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/**
 * Other ways for the computer player to choose where to go, kept apart from
 * the game's own so the balancing harness can compare them one at a time
 * (Andrei, 2026-09-30: "one change at a time"). The game uses none of them.
 */

/** The `count` POIs of `eligible` that `player` counts as closest, nearest first. */
export type ClosestFinder = (
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
) => readonly PoiCandidate[];

/** Which of `candidates` a player in an imagined game heads for. */
export type TargetPicker = (state: GameState, player: PlayerState, candidates: readonly PoiCandidate[], rng: Rng) => PoiCandidate;

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "stamina(1) = max(P - p, 0) +
 * 2*max(F - f, 0) + 3*max(M - m, 0) [...] We will count each turn as 5 stamina
 * (this is out rest stamina constant) and from that perspective define
 * effective distance = min 5n + stamina(n)"; 2026-09-30 (423): this formula.
 *
 * P, F and M are `steps`; p, f and m the player's plains, forest and mountain
 * speeds; 1, 2 and 3 are `STAMINA_COST`; 5 is `REST_STAMINA_GAIN`. n runs from
 * 1, so standing on the POI already is 5. The stamina the player has on hand
 * does not enter.
 *
 * Every term is convex in n, so once the sum starts to climb it never falls
 * again, and once every terrain the player has a speed on is covered it only
 * climbs; the search over n stops at whichever comes first.
 */
export function effectiveDistance(steps: PerTerrain<number>, stats: PlayerStats, config: GameConfig): number {
  if (!TERRAINS.every((terrain) => Number.isFinite(steps[terrain]))) return Number.POSITIVE_INFINITY;
  const speeds = refreshAllowance(stats);
  const perTurn = config.movement.REST_STAMINA_GAIN;
  const cost = config.movement.STAMINA_COST;

  let best = Number.POSITIVE_INFINITY;
  for (let turns = 1; ; turns++) {
    let total = perTurn * turns;
    let covered = true;
    for (const terrain of TERRAINS) {
      const left = steps[terrain] - turns * speeds[terrain];
      if (left <= 0) continue;
      total += cost[terrain] * left;
      if (speeds[terrain] > 0) covered = false;
    }
    if (total < best) best = total;
    else if (total > best) return best;
    if (covered) return best;
  }
}

/**
 * Closest by the player's own speeds (idea 2, 2026-09-30 12:24: "recalculating
 * distances based on current skills using the cached numbers"): each POI's
 * `effectiveDistance`, from the steps per terrain along today's cheapest route
 * (422 A), with the player's speeds now. Equal distances keep today's order:
 * weighted terrain cost, then node id. `cost` stays the weighted terrain cost,
 * and the route walked is still the cheapest one (the only one counted).
 */
export function closestBySpeeds(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  if (count <= 0 || eligible.size === 0) return [];
  const config = state.map.ruleset.config;
  const routes = routeTable(state.map.graph, config);
  const costs = routes.from(player.position).costs;
  const steps = routes.stepsFrom(player.position);

  const scored: { readonly node: NodeId; readonly cost: number; readonly distance: number }[] = [];
  for (const node of eligible) {
    const cost = costs[node] as number;
    if (!Number.isFinite(cost)) continue;
    const toNode = { plains: steps.plains[node] as number, forest: steps.forest[node] as number, mountain: steps.mountain[node] as number };
    scored.push({ node, cost, distance: effectiveDistance(toNode, player.stats, config) });
  }
  scored.sort((a, b) => a.distance - b.distance || a.cost - b.cost || a.node - b.node);
  return scored.slice(0, count).map(({ node, cost }) => ({ node, cost }));
}

/**
 * The share of the map's gold and skill units anyone has claimed: Q111's
 * progress, which is Andrei's "rewards_claimed / 120" on a map with 45 gold
 * and 75 skill units.
 */
export function rewardUnitsClaimedShare(state: GameState): number {
  let total = 0;
  let claimed = 0;
  for (let index = 0; index < state.map.pois.length; index++) {
    const reward = state.map.pois[index]?.reward;
    if (reward === undefined) continue;
    if (reward.kind !== 'gold' && !SKILL_KINDS.some((kind) => kind === reward.kind)) continue;
    total += reward.units;
    if (state.poiRuntime[index]?.claimedBy !== null) claimed += reward.units;
  }
  return total === 0 ? 1 : claimed / total;
}

/**
 * Idea 1, 2026-09-30 12:24: "simulated walks should prefer gold more as the
 * game progresses (progress measured as rewards_clamed / 120)"; 421 A: with
 * chance p a player heads for a random gold site among its closest, otherwise
 * any of them, as today. With no gold among them, any of them.
 */
export function goldByProgressPicker(): TargetPicker {
  return (state, _player, candidates, rng) => {
    const progress = rewardUnitsClaimedShare(state);
    if (rng.nextFloat() < progress) {
      const gold = candidates.filter((candidate) => poiKindAt(state, candidate.node) === 'gold');
      if (gold.length > 0) return rng.pick(gold);
    }
    return rng.pick(candidates);
  };
}

function poiKindAt(state: GameState, node: NodeId): string | undefined {
  return state.map.pois.find((poi) => poi.node === node)?.reward.kind;
}
