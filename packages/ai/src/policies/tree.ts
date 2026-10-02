import { TERRAINS, type GameConfig, type RewardKind } from '@adventure/config';
import {
  buyableNow,
  playerById,
  previewPath,
  routeTable,
  type GameState,
  type NodeId,
  type PlayerId,
  type PlayerState,
  type Rng,
} from '@adventure/core';
import { closestPoiCandidates, unclaimedPoiNodes, type ClosestFinder, type PoiCandidate, type TargetFilter } from '@adventure/sim';
import type { ActionEnumerator, MctsBranch, MctsNode, TreePolicy, TurnReachability } from '../types.ts';

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
 * [SOURCE §12.2, chat] "These POIs to explore will be the closest at the time
 * (among those that have not been claimed at that point of time in the game)",
 * plus: "rest is a branch as well. Let us prune it if there are at least
 * MIN_REACHABLE_NODES_FOR_REST = 3 POIs reachable in one turn."
 *
 * [SOURCE §12.2, review] How many is `CLOSE_CANDIDATE_COUNT`, the same K the
 * rollout policy and the remoteness walk use: "We don't really need two
 * different constants here. We will prune the tree by the CLOSE_CANDIDATE_COUNT,
 * plus one branch for resting." The tree's own `MCTS_NODE_EXPANSION_PRUNING` is
 * gone.
 *
 * Both halves are here. Targets are recomputed per node against that node's
 * state, so a POI claimed earlier in the searched line is no longer a branch
 * further down it; and the rest branch is added only when fewer than
 * `MIN_REACHABLE_NODES_FOR_REST` of those targets can actually be reached this
 * turn — which is exactly when a player is stamina-bound and resting is worth
 * considering.
 *
 * Note the reachability test runs over the pruned target list, not every POI on
 * the map: a distant reachable POI outside that list is not a branch, so
 * counting it would let rest be pruned on the strength of a target the search
 * cannot take.
 *
 * [Q190] Then a buy branch for each speed or skill the player may buy, pruned
 * as `buyBranches` says.
 */
export function closestUnclaimedPoiEnumerator(
  config: GameConfig,
  reachability: TurnReachability,
  /** Which POIs may be targets; every unclaimed one when absent, as the game plays. */
  allowed?: TargetFilter,
  /** Which of those count as closest; by weighted terrain cost when absent, as the game plays. */
  closest?: ClosestFinder,
): ActionEnumerator {
  return {
    name: 'closest-unclaimed-pois+rest+buy',
    enumerate(state: GameState, subject: PlayerId): readonly MctsBranch[] {
      const player = state.players.find((candidate) => candidate.id === subject);
      if (player === undefined) throw new RangeError(`no such player ${subject}`);

      // `closestPoiCandidates` already returns at most `CLOSE_CANDIDATE_COUNT`,
      // so this *is* the pruned target list; there is no second cap to apply.
      const eligible = allowed === undefined ? unclaimedPoiNodesOf(state) : allowed(state, player);
      const targets =
        closest === undefined
          ? closestPoiCandidates(
              state.map.graph,
              player.position,
              eligible,
              config.balancing.CLOSE_CANDIDATE_COUNT,
              config,
              routeTable(state.map.graph, config),
            )
          : closest(state, player, eligible, config.balancing.CLOSE_CANDIDATE_COUNT);

      const branches: MctsBranch[] = targets.map((target) => ({ kind: 'target', target }));

      const reachable = targets.filter((target) =>
        reachability.isReachableThisTurn(state, subject, target),
      ).length;
      if (reachable < config.ai.MIN_REACHABLE_NODES_FOR_REST) {
        branches.push({ kind: 'rest' });
      }
      branches.push(...buyBranches(state, player, config));
      return branches;
    },
  };
}

/**
 * [Q190] Andrei, 2026-10-02: "Similar to resting, it seems prudent to
 * introduce some pruning here, e.g. buying a skill is not available to a
 * computer player if that skill is within 1 turn reach from them (cached
 * distances to the skill site less or equal current speed), or 1 turn reach
 * plus some stamina." 759 B: plus `BUY_SKIP_STAMINA` stamina, and never more
 * than the player has.
 *
 * One branch for each kind the player could buy now (`buyableNow`), a unit
 * each, except a kind some unclaimed site offers within that reach: walking
 * the cached cheapest route there (Q65's steps per terrain) costs no more
 * stamina beyond this turn's free steps than that. The stamina is Q65's
 * stamina(1), Σ cost × max(steps − free steps, 0) over the three terrains.
 * Every site offering the kind counts, not only the closest few.
 */
export function buyBranches(state: GameState, player: PlayerState, config: GameConfig): readonly MctsBranch[] {
  const { kinds } = buyableNow(state, player.id);
  if (kinds.length === 0) return [];
  const spare = Math.min(config.ai.BUY_SKIP_STAMINA, player.stats.stamina);
  const near = kindsWithinReach(state, player, spare, config);
  return kinds.filter((kind) => !near.has(kind)).map((skill) => ({ kind: 'buy', skill }));
}

/** The kinds unclaimed sites offer that `player` can reach this turn for at most `spare` stamina. */
function kindsWithinReach(state: GameState, player: PlayerState, spare: number, config: GameConfig): ReadonlySet<RewardKind> {
  const steps = routeTable(state.map.graph, config).stepsFrom(player.position);
  const cost = config.movement.STAMINA_COST;
  const free = state.turn.allowance;
  const near = new Set<RewardKind>();
  state.map.pois.forEach((poi, index) => {
    if (state.poiRuntime[index]?.claimedBy !== null || near.has(poi.reward.kind)) return;
    let stamina = 0;
    for (const terrain of TERRAINS) {
      const beyond = (steps[terrain][poi.node] as number) - free[terrain];
      if (beyond > 0) stamina += cost[terrain] * beyond;
    }
    if (stamina <= spare) near.add(poi.reward.kind);
  });
  return near;
}

/** POIs whose reward is still unclaimed (§4.5) — the eligible target set. */
export function unclaimedPoiNodesOf(state: GameState): ReadonlySet<NodeId> {
  return unclaimedPoiNodes(state);
}

/**
 * [SOURCE §12.2, chat] "reachable in one turn": walking the cheapest route to
 * the target (the one metric, §5.1) arrives this turn, on this turn's
 * allowance and the player's stamina (§7). Standing on it already counts.
 */
export function previewReachability(): TurnReachability {
  return {
    isReachableThisTurn(state: GameState, subject: PlayerId, target: PoiCandidate): boolean {
      const player = playerById(state, subject);
      const config = state.map.ruleset.config;
      const route = routeTable(state.map.graph, config).path(player.position, target.node);
      if (route === null) return false;
      return previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, config)
        .destinationReachable;
    },
  };
}
