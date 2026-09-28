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
 *   select    — descend via `treePolicy.select` (UCT) among the branches a
 *               node has open, while it may not open another.
 *   expand    — when `widening` lets a node open one more branch (Q64), take
 *               the branch not yet tried in this position that
 *               `ActionEnumerator.firstToTry` puts first, and realise it
 *               through `applyAction` in `@adventure/core`, so the tree only
 *               ever contains states the real rules produced. Branches come
 *               from `ActionEnumerator`: every unclaimed POI the player could
 *               take, recomputed at that node's state, plus rest — nothing is
 *               pruned, and the order decides what is tried first (Q62).
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
  checkSearchable(root, options);
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

/**
 * `searchTree` a slice at a time, for a page that has to keep drawing while
 * the computer thinks: each `step` iterates for about `sliceMs` and then hands
 * the thread back. The budget runs on `now()` from this call, so whatever the
 * page does between slices counts against it, as it would on a chess clock.
 */
export interface SlicedSearch {
  /** Iterate for up to `sliceMs`, at least once; true once the budget is spent. */
  step(sliceMs: number): boolean;
  /** The tree so far, and the child `treePolicy.bestChild` picks from it. */
  result(): SearchResult;
}

export function startSearch(root: GameState, options: MctsOptions): SlicedSearch {
  checkSearchable(root, options);
  const tree = createRootNode(root, options);
  const deadline = options.now() + options.timeBudgetMs;
  let iterations = 0;
  return {
    step(sliceMs: number): boolean {
      const until = Math.min(deadline, options.now() + sliceMs);
      do {
        iterate(tree, root, options);
        iterations++;
      } while (options.now() < until);
      return options.now() >= deadline;
    },
    result(): SearchResult {
      if (iterations === 0) throw new RangeError('no step of the search has run yet');
      return { root: tree, best: options.treePolicy.bestChild(tree), iterations };
    },
  };
}

function checkSearchable(root: GameState, options: MctsOptions): void {
  if (root.status !== 'in_progress') throw new RangeError(`cannot search a game that is ${root.status}`);
  if (activePlayer(root).id !== options.subject) {
    throw new RangeError(`search for ${options.subject}, but it is ${activePlayer(root).id}'s turn`);
  }
}

export function createRootNode(_state: GameState, _options: MctsOptions): MctsNode {
  return { action: null, parent: null, children: [], visits: 0, totalValue: 0 };
}

/**
 * One iteration: descend from the root, replaying each branch on the way,
 * until a node may open a branch nobody has tried yet in this position and
 * expands it; then roll out and backpropagate.
 */
function iterate(tree: MctsNode, root: GameState, options: MctsOptions): void {
  const rules = rolloutOptions(options);
  let cursor = rolloutCursor(root, options.subject);
  let node = tree;

  while (!options.termination.isTerminal(cursor, 0)) {
    const branches = options.actions.enumerate(cursor.state, options.subject);
    const childOf = new Map(node.children.map((child) => [branchKey(child.action as MctsBranch), child]));
    const available: MctsNode[] = [];
    const untried: MctsBranch[] = [];
    for (const branch of branches) {
      const child = childOf.get(branchKey(branch));
      if (child === undefined) untried.push(branch);
      else available.push(child);
    }

    if (untried.length > 0 && (node.children.length < options.widening.openLimit(node.visits) || available.length === 0)) {
      const branch = options.actions.firstToTry(cursor.state, options.subject, untried, options.rng);
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

/**
 * Branches are the same decision when they head for the same POI, or both
 * rest: one key per decision. With nothing pruned a node can have a child per
 * POI on the map, so children are looked up by it rather than searched.
 */
function branchKey(branch: MctsBranch): number {
  return branch.kind === 'rest' ? -1 : branch.target.node;
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
