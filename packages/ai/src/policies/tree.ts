import type { GameConfig } from '@adventure/config';
import {
  activePlayer,
  guardSkillStat,
  playerById,
  poiAt,
  previewPath,
  refreshAllowance,
  routeTable,
  type GameState,
  type NodeId,
  type PlayerId,
  type PlayerStats,
  type Poi,
  type Rng,
} from '@adventure/core';
import type { ActionEnumerator, MctsBranch, MctsNode, TreePolicy, Widening } from '../types.ts';

/**
 * [SOURCE §12.2, chat] "For everything else please use sensible defaults that
 * are recommended for standard MCTS implementations."
 *
 * That default is UCT — UCB1 applied to the tree:
 *
 *   value(child) = child.totalValue / child.visits
 *                + c × sqrt( ln(parent.visits) / child.visits )
 *
 * with an unvisited child taken first (its term is infinite). The final move is
 * the **most-visited** child rather than the highest-valued one — the "robust
 * child" rule, which is the standard recommendation because visit counts are
 * far less noisy than value estimates at the end of a fixed time budget.
 *
 * Ties are broken with the injected `Rng`, so a search is reproducible from its
 * seed like everything else in this repo.
 *
 * √2 is the right constant here because every evaluator returns a value in
 * [0, 1] (OPEN_QUESTIONS Q14) — the range UCB1's derivation assumes. Gold terms
 * get there by dividing by total map gold; the estimated evaluator's two terms
 * are each normalised and its weights sum to 1 (Q18). The two settings are
 * coupled.
 */
export function uctTreePolicy(explorationConstant: number): TreePolicy {
  return {
    name: 'uct',

    select(node: MctsNode, available: readonly MctsNode[], rng: Rng): MctsNode {
      if (available.length === 0) {
        throw new RangeError('uctTreePolicy.select called with no child to choose');
      }
      return argMaxWithRandomTieBreak(
        available,
        (child) =>
          child.visits === 0
            ? Number.POSITIVE_INFINITY
            : child.totalValue / child.visits +
              explorationConstant * Math.sqrt(Math.log(node.visits) / child.visits),
        rng,
      );
    },

    bestChild(root: MctsNode): MctsNode {
      // Robust child: most visits, mean value as the tiebreak. Deterministic —
      // no `Rng` is threaded here, and the final move should not be a coin flip.
      let best: MctsNode | null = null;
      for (const child of root.children) {
        if (best === null || beats(child, best)) best = child;
      }
      if (best === null) {
        throw new RangeError('uctTreePolicy.bestChild called on a node with no children');
      }
      return best;
    },
  };
}

function meanValue(node: MctsNode): number {
  return node.visits === 0 ? 0 : node.totalValue / node.visits;
}

function beats(candidate: MctsNode, incumbent: MctsNode): boolean {
  if (candidate.visits !== incumbent.visits) return candidate.visits > incumbent.visits;
  return meanValue(candidate) > meanValue(incumbent);
}

function argMaxWithRandomTieBreak<T>(items: readonly T[], score: (item: T) => number, rng: Rng): T {
  let best: T[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = [item];
    } else if (value === bestScore) {
      best.push(item);
    }
  }
  const first = best[0];
  if (first === undefined) throw new RangeError('argMax over an empty collection');
  return best.length === 1 ? first : rng.pick(best);
}

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q64): a node that has had n games
 * through it has the first ⌈√n⌉ branches in the order open (150), at every
 * node including the root (151). So the 1st opens at the first game, the 2nd
 * at 2 games, the 3rd at 5, the 10th at 82 and the 50th at 2,402.
 */
export function squareRootWidening(): Widening {
  return {
    name: 'square-root',
    openLimit: (visits) => Math.max(1, Math.ceil(Math.sqrt(visits))),
  };
}

/** Every branch open from the start: each is tried once before any is tried twice. */
export function noWidening(): Widening {
  return { name: 'none', openLimit: () => Number.POSITIVE_INFINITY };
}

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q62): no move choice is pruned, and
 * the choices at every node are sorted so the most promising are tried first.
 * This replaces §12.2's pruning to the `CLOSE_CANDIDATE_COUNT` closest POIs and
 * its rest rule.
 *
 * The branches, recomputed at each node against that node's own state:
 *
 *  - every unclaimed POI, except a guarded one the player has no chance
 *    against — "the gold one cannot beat is left out of one's choices
 *    completely" (127). In v1 only gold is guarded; the test is on the guard,
 *    as everywhere in the engine;
 *  - resting, always: "resting is always a choice" (129).
 *
 * The order `firstToTry` applies, in Andrei's words:
 *
 *  1. "First consider moves that the player can reach in one turn, than in
 *     two turns, etc." Resting comes "between all POI that take 1 turn to reach
 *     and those that take more than one" (129).
 *  2. "Out of the POIs one can reach in N turns, first consider those that
 *     require less stamina."
 *  3. "Out of those that require spending equal stamina to get there, first
 *     consider those that offer more units the reward", a guarded reward's
 *     units multiplied by the chance one roll of the die beats its guard.
 *  4. Ties at random (128).
 *
 * Turns and stamina are counted along the cheapest route, the one the player
 * would walk, as the rules would play it (126); see `journeyTo`.
 */
export function sortedPoiEnumerator(config: GameConfig): ActionEnumerator {
  return {
    name: 'every-unclaimed-poi-sorted+rest',

    enumerate(state: GameState, subject: PlayerId): readonly MctsBranch[] {
      const player = playerById(state, subject);
      const { costs } = routeTable(state.map.graph, config).from(player.position);
      const branches: MctsBranch[] = [];
      for (let index = 0; index < state.map.pois.length; index++) {
        const poi = state.map.pois[index];
        if (poi === undefined || state.poiRuntime[index]?.claimedBy !== null) continue;
        if (winningOutcomes(poi, player.stats, config) === 0) continue;
        branches.push({ kind: 'target', target: { node: poi.node, cost: costs[poi.node] as number } });
      }
      branches.push({ kind: 'rest' });
      return branches;
    },

    firstToTry(state: GameState, subject: PlayerId, untried: readonly MctsBranch[], rng: Rng): MctsBranch {
      let first: MctsBranch[] = [];
      let firstKey: OrderKey | null = null;
      for (const branch of untried) {
        const key = orderKey(state, subject, branch, config);
        const order = firstKey === null ? -1 : compareOrderKeys(key, firstKey);
        if (order < 0) {
          first = [branch];
          firstKey = key;
        } else if (order === 0) {
          first.push(branch);
        }
      }
      const only = first[0];
      if (only === undefined) throw new RangeError('firstToTry called with no untried branch');
      return first.length === 1 ? only : rng.pick(first);
    },
  };
}

/**
 * Where a branch stands in Q62's order. Smaller comes first on `turns`, then
 * on `stamina`; larger comes first on `units`.
 *
 * `units` is kept in whole numbers so equal rewards compare equal exactly:
 * it is the reward's units times the number of die outcomes that take it, out
 * of every outcome the die has — so an unguarded reward counts all of them,
 * and one guarded by 7 against a skill of 3, won by a 5 or a 6 on 1d6, counts
 * two sixths of its units.
 */
export interface OrderKey {
  readonly turns: number;
  readonly stamina: number;
  readonly units: number;
}

/** Resting sits after every POI reachable this turn and before every other (129). */
const REST_KEY: OrderKey = { turns: 1.5, stamina: 0, units: 0 };

export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  if (a.turns !== b.turns) return a.turns - b.turns;
  if (a.stamina !== b.stamina) return a.stamina - b.stamina;
  return b.units - a.units;
}

export function orderKey(state: GameState, subject: PlayerId, branch: MctsBranch, config: GameConfig): OrderKey {
  if (branch.kind === 'rest') return REST_KEY;
  const poi = poiAt(state.map, branch.target.node);
  if (poi === undefined) throw new RangeError(`node ${branch.target.node} is not a POI`);
  const player = playerById(state, subject);
  const route = routeTable(state.map.graph, config).path(player.position, poi.node);
  if (route === null) throw new RangeError(`no route from ${player.position} to ${poi.node}`);
  const { turns, stamina } = journeyTo(state, subject, route, config);
  return { turns, stamina, units: poi.reward.units * winningOutcomes(poi, player.stats, config) };
}

/**
 * How many turns walking `route` takes, and how much stamina it spends, as the
 * rules would play it (126): each turn the free steps first, then stamina,
 * stopping at the first step that cannot be paid for (`previewPath`, the same
 * accounting as a real move); a turn that cannot take a single step is a rest
 * (Q43), which gives back `REST_STAMINA_GAIN`. The first turn has this turn's
 * allowance, every later one the player's skills. Skills stay as they are now:
 * rewards picked up on the way are not counted.
 *
 * Standing on the POI already is the empty route: reached this turn, for
 * nothing — the zero-length move that tries its guard again.
 */
export function journeyTo(
  state: GameState,
  subject: PlayerId,
  route: readonly NodeId[],
  config: GameConfig,
): { readonly turns: number; readonly stamina: number } {
  if (route.length === 0) return { turns: 1, stamina: 0 };

  const player = playerById(state, subject);
  const graph = state.map.graph;
  const everyTurn = refreshAllowance(player.stats);
  const gain = config.movement.REST_STAMINA_GAIN;
  let allowance = activePlayer(state).id === subject ? state.turn.allowance : everyTurn;
  let position = player.position;
  let remaining = route;
  let stamina = player.stats.stamina;
  let spent = 0;

  for (let turns = 1; ; turns++) {
    const preview = previewPath(graph, position, remaining, allowance, stamina, config);
    const steps = preview.reachableStepCount;
    if (steps === 0) {
      // Resting gets nowhere if it gives back nothing; no count is right then.
      if (gain <= 0) return { turns: Number.POSITIVE_INFINITY, stamina: Number.POSITIVE_INFINITY };
      stamina += gain;
    } else {
      stamina -= preview.totalStaminaCost;
      spent += preview.totalStaminaCost;
      position = remaining[steps - 1] as NodeId;
      remaining = remaining.slice(steps);
      if (remaining.length === 0) return { turns, stamina: spent };
    }
    allowance = everyTurn;
  }
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
