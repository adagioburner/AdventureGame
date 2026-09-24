import { activePlayer, applyAction, type GameState, type TurnAction } from '@adventure/core';
import {
  macroAdvanceToTarget,
  playUntilTurnOf,
  rolloutCursor,
  turnTowards,
  type RolloutCursor,
  type RolloutOptions,
} from '@adventure/sim';
import type { MctsBranch, MctsNode, MctsOptions } from './types.ts';

/**
 * [SOURCE §5] "Implemented via MCTS."
 *
 * The four phases, now that §12.2 is decided:
 *
 *   select    — descend via `treePolicy.select` (UCT) while every branch of a
 *               node is expanded.
 *   expand    — take one branch not yet tried in this position and realise it
 *               through `applyAction` in `@adventure/core`, so the tree only
 *               ever contains states the real rules produced. Branches come
 *               from `ActionEnumerator`: the `CLOSE_CANDIDATE_COUNT` closest
 *               *unclaimed* POIs, recomputed at that node's state, plus a rest
 *               branch when fewer than `MIN_REACHABLE_NODES_FOR_REST` of them
 *               are reachable this turn.
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
 * [SOURCE §9, chat] Tree expansion uses the same macro-action semantics as the
 * rollout — confirmed, so a tree edge and a rollout leg mean the same thing and
 * node values compose. The same commitment also governs the §5.1 remoteness
 * walk, which already worked this way.
 *
 * Every node is a decision point of the subject: an edge is the subject's
 * macro-action and then the other seats' turns, played by the rollout policy,
 * until the subject is to move again. Nodes keep no position (see `MctsNode`):
 * each iteration replays the path from the root, so dice and the other seats'
 * choices are sampled afresh every time, and a branch is judged on all its
 * outcomes rather than on the first one it happened to have.
 */
export function search(root: GameState, options: MctsOptions): TurnAction {
  const { best } = searchTree(root, options);
  return firstTurnOf(root, best.action, options);
}

/** What a search found, for the harness and the playthrough log. */
export interface SearchResult {
  readonly root: MctsNode;
  /** The child `treePolicy.bestChild` picked; its `action` is the branch taken. */
  readonly best: MctsNode;
  /** Completed iterations: one descent, rollout and backpropagation each. */
  readonly iterations: number;
}

/** `search()`, keeping the tree. */
export function searchTree(root: GameState, options: MctsOptions): SearchResult {
  if (root.status !== 'in_progress') throw new RangeError(`cannot search a game that is ${root.status}`);
  if (activePlayer(root).id !== options.subject) {
    throw new RangeError(`search for ${options.subject}, but it is ${activePlayer(root).id}'s turn`);
  }

  const tree = createRootNode(root, options);
  const start = options.now();
  let iterations = 0;
  // At least one iteration, so a budget spent before the first gives a move.
  do {
    iterate(tree, root, options);
    iterations++;
  } while (options.now() - start < options.timeBudgetMs);

  return { root: tree, best: options.treePolicy.bestChild(tree), iterations };
}

export function createRootNode(_state: GameState, _options: MctsOptions): MctsNode {
  return { action: null, parent: null, children: [], visits: 0, totalValue: 0 };
}

/**
 * One iteration: descend from the root, replaying each branch on the way,
 * until a branch nobody has tried yet in this position is expanded; then roll
 * out and backpropagate.
 */
function iterate(tree: MctsNode, root: GameState, options: MctsOptions): void {
  const rules = rolloutOptions(options);
  let cursor = rolloutCursor(root, options.subject);
  let node = tree;

  while (!options.termination.isTerminal(cursor, 0)) {
    const branches = options.actions.enumerate(cursor.state, options.subject);
    const available: MctsNode[] = [];
    const untried: MctsBranch[] = [];
    for (const branch of branches) {
      const child = node.children.find((candidate) => sameBranch(candidate.action, branch));
      if (child === undefined) untried.push(branch);
      else available.push(child);
    }

    if (untried.length > 0) {
      const branch = untried[options.rng.nextInt(untried.length)] as MctsBranch;
      const child: MctsNode = { action: branch, parent: node, children: [], visits: 0, totalValue: 0 };
      node.children.push(child);
      cursor = realise(cursor, branch, options, rules);
      node = child;
      break;
    }
    if (available.length === 0) break;
    node = options.treePolicy.select(node, available, options.rng);
    cursor = realise(cursor, node.action as MctsBranch, options, rules);
  }

  const rolledOut = options.rollout.run(cursor, options.rng, options.dice);
  const value = options.evaluator.evaluate(cursor, rolledOut, options.subject);
  for (let at: MctsNode | null = node; at !== null; at = at.parent) {
    at.visits += 1;
    at.totalValue += value;
  }
}

/** Branches are the same decision when they head for the same POI, or both rest. */
function sameBranch(a: MctsBranch | null, b: MctsBranch): boolean {
  if (a === null) return false;
  if (a.kind === 'rest' || b.kind === 'rest') return a.kind === b.kind;
  return a.target.node === b.target.node;
}

/**
 * The subject's macro-action for `branch`, then the other seats' turns until
 * the subject is to move again.
 */
function realise(cursor: RolloutCursor, branch: MctsBranch, options: MctsOptions, rules: RolloutOptions): RolloutCursor {
  let after: RolloutCursor;
  if (branch.kind === 'rest') {
    const rested = applyAction(cursor.state, { kind: 'rest', player: options.subject }, options.dice).state;
    after = { ...cursor, state: rested };
  } else {
    after = macroAdvanceToTarget(cursor, branch.target.node, rules).cursor;
  }
  return playUntilTurnOf(after, options.subject, rules);
}

/** The move a branch makes this turn: the first turn of its macro-action. */
export function firstTurnOf(state: GameState, branch: MctsBranch | null, options: MctsOptions): TurnAction {
  if (branch === null) throw new RangeError('the search found no branch to take');
  if (branch.kind === 'rest') return { kind: 'rest', player: options.subject };
  return turnTowards(state, branch.target.node, options.restRule);
}

function rolloutOptions(options: MctsOptions): RolloutOptions {
  return {
    config: options.config,
    termination: options.termination,
    restRule: options.restRule,
    dice: options.dice,
    rng: options.rng,
  };
}
