import type { GameConfig } from '@adventure/config';
import { playerById, previewPath, shortestPath, type GameState, type NodeId, type PlayerId, type Rng } from '@adventure/core';
import { closestPoiCandidates, unclaimedPoiNodes, type PoiCandidate } from '@adventure/sim';
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
 */
export function closestUnclaimedPoiEnumerator(
  config: GameConfig,
  reachability: TurnReachability,
): ActionEnumerator {
  return {
    name: 'closest-unclaimed-pois+rest',
    enumerate(state: GameState, subject: PlayerId): readonly MctsBranch[] {
      const player = state.players.find((candidate) => candidate.id === subject);
      if (player === undefined) throw new RangeError(`no such player ${subject}`);

      // `closestPoiCandidates` already returns at most `CLOSE_CANDIDATE_COUNT`,
      // so this *is* the pruned target list; there is no second cap to apply.
      const eligible = unclaimedPoiNodesOf(state);
      const targets = closestPoiCandidates(state.map.graph, player.position, eligible, config);

      const branches: MctsBranch[] = targets.map((target) => ({ kind: 'target', target }));

      const reachable = targets.filter((target) =>
        reachability.isReachableThisTurn(state, subject, target),
      ).length;
      if (reachable < config.ai.MIN_REACHABLE_NODES_FOR_REST) {
        branches.push({ kind: 'rest' });
      }
      return branches;
    },
  };
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
      const route = shortestPath(state.map.graph, player.position, target.node, config);
      if (route === null) return false;
      return previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, config)
        .destinationReachable;
    },
  };
}
