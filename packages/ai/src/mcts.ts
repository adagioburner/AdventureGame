import { NotImplementedError, type GameState, type TurnAction } from '@adventure/core';
import type { MctsNode, MctsOptions } from './types.ts';

/**
 * [SOURCE §5] "Implemented via MCTS."
 *
 * The four phases, now that §12.2 is decided:
 *
 *   select    — descend via `treePolicy.select` (UCT) while every branch of a
 *               node is expanded.
 *   expand    — take one untried POI target from `node.untried` and realise it
 *               through `applyAction` in `@adventure/core`, so the tree only
 *               ever contains states the real rules produced. Branches come
 *               from `ActionEnumerator`: the `MCTS_NODE_EXPANSION_PRUNING`
 *               closest *unclaimed* POIs, recomputed at that node's state.
 *   simulate  — `rollout.run`, which is §5.1's random walk driven through the
 *               real rules (see `@adventure/sim`).
 *   backprop  — add `evaluator.evaluate(...)` to every node on the path.
 *
 * Loop until `now() - start >= timeBudgetMs`, then return the move implied by
 * `treePolicy.bestChild(root)`.
 *
 * **The one thing left to settle before this can be written** is how a POI
 * target becomes a `TurnAction`: whether choosing a target advances the search
 * state by one turn toward it, or by the whole multi-turn journey until arrival
 * (a macro-action). Both are consistent with what has been specified, they give
 * very different trees, and the conversion at the end of `search()` differs
 * accordingly. See OPEN_QUESTIONS Q17 — with Q16 (is "rest" also a branch?).
 */
export function search(_root: GameState, _options: MctsOptions): TurnAction {
  throw new NotImplementedError(
    'MCTS search — policies are decided; target-to-TurnAction conversion is not',
    'GDD.md §9, §12.2 / docs/OPEN_QUESTIONS.md Q17',
  );
}

export function createRootNode(_state: GameState, _options: MctsOptions): MctsNode {
  throw new NotImplementedError('createRootNode', 'GDD.md §9');
}
