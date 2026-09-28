import { TERRAINS, type GameConfig, type PerTerrain, type RewardKind } from '@adventure/config';
import {
  guardSkillStat,
  playerById,
  refreshAllowance,
  routeTable,
  type GameState,
  type PlayerId,
  type PlayerStats,
  type Poi,
  type Rng,
} from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): which POIs the computer and
 * its imagined players head for. It replaces the `CLOSE_CANDIDATE_COUNT`
 * closest, in the search and in the games it plays in its head alike:
 *
 *   "For pruning we will take 2 most attractive POI of each kind [...] The
 *   simulation will choose randomly among the same set of POI."
 *
 * The kinds are these six, "there will be 12 of them" (158). Stamina is never
 * a target. Gold is one kind, whether a fighting or a magic guard holds it.
 */
export const TARGET_KINDS = [
  'plains_move',
  'forest_move',
  'mountain_move',
  'fighting',
  'magic',
  'gold',
] as const satisfies readonly RewardKind[];

/** One unclaimed POI a player could head for, with what makes it attractive. */
export interface ScoredTarget extends PoiCandidate {
  readonly kind: RewardKind;
  /** Steps onto each terrain along the cheapest route to it (155). */
  readonly steps: PerTerrain<number>;
  /** `effectiveDistance` of those steps with the player's speeds. */
  readonly distance: number;
  readonly units: number;
  /** The die's outcomes that take the reward, of `outcomes`: all of them when unguarded. */
  readonly winning: number;
  readonly outcomes: number;
}

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "stamina(1) = max(P - p, 0) +
 * 2*max(F - f, 0) + 3*max(M - m, 0) [...] We will count each turn as 5 stamina
 * (this is out rest stamina constant) and from that perspective define
 * effective distance = min 5n + stamina(n)".
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
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "we take the effective
 * distance to it and divide it by the number of skills it gives. If the POI is
 * guarded, we also [divide] this number by the probability to get the reward
 * in 1 turn" (06:38: "divide [...] not multiply"), and "more attractive means
 * less effective distance divided by the number of skills".
 *
 * So: effective distance ÷ (units × the chance one roll takes it). Smaller is
 * more attractive. Gold no roll can win is infinitely far, and is never kept
 * (165).
 */
export function attractiveness(target: ScoredTarget): number {
  return (target.distance * target.outcomes) / (target.units * target.winning);
}

/**
 * Negative when `a` is more attractive than `b`, 0 when they are equal. Compared
 * by cross-multiplying, so equal attractiveness compares equal exactly and a
 * tie is a tie (157).
 */
export function compareAttractiveness(a: ScoredTarget, b: ScoredTarget): number {
  return a.distance * b.units * b.winning - b.distance * a.units * a.winning;
}

/**
 * Every unclaimed POI of the `TARGET_KINDS` that `subject` could take, scored
 * from where it stands with its own skills. Gold whose guard no roll can beat
 * is left out (165), and so is stamina (158).
 */
export function scoredTargets(state: GameState, subject: PlayerId, config: GameConfig): readonly ScoredTarget[] {
  const player = playerById(state, subject);
  const routes = routeTable(state.map.graph, config);
  const { costs } = routes.from(player.position);
  const steps = routes.stepsFrom(player.position);
  const outcomes = dieOutcomes(config);

  const scored: ScoredTarget[] = [];
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined || state.poiRuntime[index]?.claimedBy !== null) continue;
    if (!isTargetKind(poi.reward.kind)) continue;
    const winning = winningOutcomes(poi, player.stats, config);
    if (winning === 0) continue;
    const toPoi = {
      plains: steps.plains[poi.node] as number,
      forest: steps.forest[poi.node] as number,
      mountain: steps.mountain[poi.node] as number,
    };
    const distance = effectiveDistance(toPoi, player.stats, config);
    if (!Number.isFinite(distance)) continue;
    scored.push({
      node: poi.node,
      cost: costs[poi.node] as number,
      kind: poi.reward.kind,
      steps: toPoi,
      distance,
      units: poi.reward.units,
      winning,
      outcomes,
    });
  }
  return scored;
}

/**
 * Which `wanted` of `tied`, equally attractive, to keep. Ties are settled at
 * random (157); `atRandom` draws afresh each time, which is right for a
 * player choosing once, and the search settles them the same way at every
 * visit to a position (see `attractivePoiEnumerator` in `@adventure/ai`).
 */
export type SettleTie = (tied: readonly ScoredTarget[], wanted: number) => readonly ScoredTarget[];

/** Settle a tie with a fresh draw from `rng`. */
export function atRandom(rng: Rng): SettleTie {
  return (tied, wanted) => rng.shuffle(tied).slice(0, wanted);
}

/**
 * The `perKind` most attractive of each kind in `scored`; all of a kind when
 * fewer are left. A tie for the last place is settled by `settleTie` (157).
 */
export function keepMostAttractive(
  scored: readonly ScoredTarget[],
  perKind: number,
  settleTie: SettleTie,
): readonly ScoredTarget[] {
  const kept: ScoredTarget[] = [];
  for (const kind of TARGET_KINDS) {
    const ofKind = scored.filter((target) => target.kind === kind);
    if (ofKind.length <= perKind) {
      kept.push(...ofKind);
      continue;
    }
    ofKind.sort(compareAttractiveness);
    const last = ofKind[perKind - 1] as ScoredTarget;
    const sure = ofKind.filter((target) => compareAttractiveness(target, last) < 0);
    const tied = ofKind.filter((target) => compareAttractiveness(target, last) === 0);
    const wanted = perKind - sure.length;
    kept.push(...sure, ...(tied.length === wanted ? tied : settleTie(tied, wanted)));
  }
  return kept;
}

/**
 * The POIs `subject` weighs from where it stands: the `ATTRACTIVE_POIS_PER_KIND`
 * most attractive of each kind (Q65). The computer's search branches over
 * these plus rest; a player in the games it plays in its head picks one of
 * them at random, and rests when there are none (164).
 */
export function attractiveTargets(
  state: GameState,
  subject: PlayerId,
  config: GameConfig,
  settleTie: SettleTie,
): readonly ScoredTarget[] {
  return keepMostAttractive(scoredTargets(state, subject, config), config.ai.ATTRACTIVE_POIS_PER_KIND, settleTie);
}

function isTargetKind(kind: RewardKind): boolean {
  return (TARGET_KINDS as readonly RewardKind[]).includes(kind);
}

/**
 * How many of the die's outcomes take `poi`'s reward, out of `dieOutcomes`:
 * all of them when it is unguarded, else those where the roll plus the
 * matching skill is higher than the guard (§8). 0 is a guard with no chance.
 */
export function winningOutcomes(poi: Poi, stats: PlayerStats, config: GameConfig): number {
  if (poi.guard === null) return dieOutcomes(config);
  const needed = poi.guard.strength - stats[guardSkillStat(poi.guard)];
  let winning = 0;
  dieSums(config).forEach((ways, sum) => {
    if (sum > needed) winning += ways;
  });
  return winning;
}

/** Every outcome of `GUARD_DIE`: sides to the power of the number of dice. */
export function dieOutcomes(config: GameConfig): number {
  const { count, sides } = config.combat.GUARD_DIE;
  return sides ** count;
}

/** How many ways `GUARD_DIE` rolls each sum, indexed by the sum. */
function dieSums(config: GameConfig): readonly number[] {
  const { count, sides } = config.combat.GUARD_DIE;
  let ways = [1];
  for (let die = 0; die < count; die++) {
    const next = new Array<number>(ways.length + sides).fill(0);
    ways.forEach((waysToSum, sum) => {
      for (let face = 1; face <= sides; face++) next[sum + face] = (next[sum + face] ?? 0) + waysToSum;
    });
    ways = next;
  }
  return ways;
}
