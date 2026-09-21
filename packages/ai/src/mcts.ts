import { NotImplementedError, type GameState, type TurnAction } from '@adventure/core';
import type { MctsNode, MctsOptions } from './types.ts';

/**
 * [SOURCE §5] "Implemented via MCTS."
 *
 * The four phases, now that §12.2 is decided:
 *
 *   select    — descend via `treePolicy.select` (UCT) while every branch of a
 *               node is expanded.
 *   expand    — take one untried branch from `node.untried` and realise it
 *               through `applyAction` in `@adventure/core`, so the tree only
 *               ever contains states the real rules produced. Branches come
 *               from `ActionEnumerator`: the `MCTS_NODE_EXPANSION_PRUNING`
 *               closest *unclaimed* POIs, recomputed at that node's state,
 *               plus a rest branch when fewer than
 *               `MIN_REACHABLE_NODES_FOR_REST` of them are reachable this turn.
 *               A target branch is a macro-action — `macroAdvanceToTarget` —
 *               so one edge can span several turns.
 *   simulate  — `rollout.run`, which is §5.1's random walk driven through the
 *               real rules (see `@adventure/sim`).
 *   backprop  — add `evaluator.evaluate(...)` to every node on the path.
 *
 * Loop until `now() - start >= timeBudgetMs`, then return the move implied by
 * `treePolicy.bestChild(root)`.
 *
 * `search()` returns a single `TurnAction` — the **first turn** of the branch
 * `bestChild` picks, since the session layer commits one turn at a time. The
 * rest of a macro-action is re-derived on the AI's next turn, when the search
 * runs again from the new state.
 *
 * One reading to confirm: [SOURCE §9, chat] specified the macro-action "during
 * simulation rollout". Tree expansion uses the same semantics here, because a
 * tree edge and a rollout leg have to mean the same thing for node values to
 * compose — but that is an inference from the rollout answer, not something
 * stated for the tree. See OPEN_QUESTIONS Q17.
 */
export function search(_root: GameState, _options: MctsOptions): TurnAction {
  throw new NotImplementedError('MCTS search', 'GDD.md §9, §12.2');
}

export function createRootNode(_state: GameState, _options: MctsOptions): MctsNode {
  throw new NotImplementedError('createRootNode', 'GDD.md §9');
}
