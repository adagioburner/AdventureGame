import { NotImplementedError, type GameState, type TurnAction } from '@adventure/core';
import type { MctsNode, MctsOptions } from './types.ts';

/**
 * [SOURCE §5] "Implemented via MCTS."
 *
 * The four phases are the standard ones and are written out here so the shape
 * is fixed before anything fills them in:
 *
 *   select    — descend via `treePolicy.select` while every child is expanded.
 *   expand    — take one action from `node.untried` and apply it through
 *               `applyAction` in `@adventure/core`, so the tree only ever
 *               contains states the real rules produced.
 *   simulate  — `rollout.run`, which is §5.1's random walk driven through the
 *               real rules (see `@adventure/sim`).
 *   backprop  — add `evaluator.evaluate(...)` to every node on the path.
 *
 * Loop until `now() - start >= timeBudgetMs`, then return
 * `treePolicy.bestChild(root).action`.
 *
 * Unimplemented because two of the four phases depend on §12.2: selection has
 * no policy, and expansion has no action enumeration. The other two are
 * specified and could be written today, which is exactly why they live behind
 * their own interfaces here rather than inside this function.
 */
export function search(_root: GameState, _options: MctsOptions): TurnAction {
  throw new NotImplementedError('MCTS search (tree policy unspecified)', 'GDD.md §9, §12.2');
}

export function createRootNode(_state: GameState, _options: MctsOptions): MctsNode {
  throw new NotImplementedError('createRootNode', 'GDD.md §9');
}
