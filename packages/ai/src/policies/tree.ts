import type { GameConfig } from '@adventure/config';
import type { GameState, NodeId, PlayerId, Rng } from '@adventure/core';
import { attractiveTargets, type ScoredTarget, type SettleTie } from '@adventure/sim';
import type { ActionEnumerator, MctsBranch, MctsNode, TreePolicy } from '../types.ts';

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
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "For pruning we will take 2
 * most attractive POI of each kind", replacing §12.2's pruning to the
 * `CLOSE_CANDIDATE_COUNT` closest and its rest rule.
 *
 * The branches, recomputed at each node against that node's own state, from
 * where the player stands there and with its skills there:
 *
 *  - the `ATTRACTIVE_POIS_PER_KIND` most attractive unclaimed POIs of each of
 *    the six kinds, `attractiveTargets` in `@adventure/sim`, the same set the
 *    games played in the search's head pick from;
 *  - resting, always: "resting is a choice" (160).
 *
 * All of them are open at once, as before Q64 (161): the search tries a
 * branch not yet tried at a node, drawn at random, before any twice.
 *
 * Ties are settled at random (157), by one random order of the map's POIs
 * drawn when the search first asks. So a position the search comes back to
 * keeps the same POIs: the root is the same position at every visit, and a
 * fresh draw each time would let every tied POI in by turns, more than
 * `ATTRACTIVE_POIS_PER_KIND` of a kind.
 */
export function attractivePoiEnumerator(config: GameConfig): ActionEnumerator {
  let settleTie: SettleTie | null = null;
  return {
    name: 'attractive-pois-per-kind+rest',
    enumerate(state: GameState, subject: PlayerId, rng: Rng): readonly MctsBranch[] {
      settleTie ??= inOneRandomOrder(state, rng);
      const branches: MctsBranch[] = attractiveTargets(state, subject, config, settleTie).map((target) => ({
        kind: 'target',
        target,
      }));
      branches.push({ kind: 'rest' });
      return branches;
    },
  };
}

/** Settle every tie by where the POIs fall in one shuffle of the map's POIs. */
function inOneRandomOrder(state: GameState, rng: Rng): SettleTie {
  const place = new Map<NodeId, number>(rng.shuffle(state.map.pois.map((poi) => poi.node)).map((node, at) => [node, at]));
  const placeOf = (target: ScoredTarget) => place.get(target.node) ?? 0;
  return (tied, wanted) => [...tied].sort((a, b) => placeOf(a) - placeOf(b)).slice(0, wanted);
}
