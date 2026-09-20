import type { GameConfig } from '@adventure/config';
import type { GameState, NodeId, PlayerId, Rng } from '@adventure/core';
import { closestPoiCandidates, type PoiCandidate } from '@adventure/sim';
import type { ActionEnumerator, MctsNode, TreePolicy } from '../types.ts';

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
 * See the caveat on `MCTS_EXPLORATION_CONSTANT`: UCB1's √2 assumes values in
 * [0, 1], and gold is not. That is a tuning matter (OPEN_QUESTIONS Q14), not a
 * reason to deviate from the standard formula here.
 */
export function uctTreePolicy(explorationConstant: number): TreePolicy {
  return {
    name: 'uct',

    select(node: MctsNode, rng: Rng): MctsNode {
      if (node.children.length === 0) {
        throw new RangeError('uctTreePolicy.select called on a node with no children');
      }
      return argMaxWithRandomTieBreak(
        node.children,
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
 * [SOURCE §12.2, chat] "These 10 POIs to explore will be the closest at the
 * time (among those that have not been claimed at that point of time in the
 * game)."
 *
 * Recomputed per node against that node's state, so a POI claimed earlier in
 * the searched line is no longer a branch further down it.
 */
export function closestUnclaimedPoiEnumerator(config: GameConfig): ActionEnumerator {
  return {
    name: 'closest-unclaimed-pois',
    enumerate(state: GameState, subject: PlayerId): readonly PoiCandidate[] {
      const player = state.players.find((candidate) => candidate.id === subject);
      if (player === undefined) throw new RangeError(`no such player ${subject}`);
      const eligible = unclaimedPoiNodesOf(state);
      const ranked = closestPoiCandidates(state.map.graph, player.position, eligible, config);
      return ranked.slice(0, config.ai.MCTS_NODE_EXPANSION_PRUNING);
    },
  };
}

/** POIs whose reward is still unclaimed (§4.5) — the eligible target set. */
export function unclaimedPoiNodesOf(state: GameState): ReadonlySet<NodeId> {
  const nodes = new Set<NodeId>();
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined) continue;
    if (state.poiRuntime[index]?.claimedBy === null) nodes.add(poi.node);
  }
  return nodes;
}
