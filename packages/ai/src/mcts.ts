import { activePlayer, applyAction, type BuyAction, type GameState, type TurnAction } from '@adventure/core';
import {
  bestRouteForSpeeds,
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
 *               real rules (see `@adventure/sim`); skipped for an evaluator
 *               that does not read it (the estimated one).
 *   backprop  — add `evaluator.evaluate(...)` to every node on the path.
 *
 * Loop until `now() - start >= timeBudgetMs`, then return the move implied by
 * `treePolicy.bestChild(root)`.
 *
 * `search()` returns this turn's plan (`planTurn`): the purchases on the way
 * down the tree, if any (Q190), and then a single `TurnAction` — the **first
 * turn** of the branch picked after them, since the session layer commits one
 * turn at a time. The rest of a macro-action is re-derived on the AI's next
 * turn, when the search runs again from the new state.
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
export function search(root: GameState, options: MctsOptions): TurnPlan {
  return planTurn(root, searchTree(root, options), options);
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

  const rolledOut = options.evaluator.readsRollout ? options.rollout.run(cursor, options.rng, options.dice) : cursor;
  const value = options.evaluator.evaluate(cursor, rolledOut, options.subject);
  for (let at: MctsNode | null = node; at !== null; at = at.parent) {
    at.visits += 1;
    at.totalValue += value;
  }
}

/** Branches are the same decision when they head for the same POI, both rest, or buy the same kind. */
function sameBranch(a: MctsBranch | null, b: MctsBranch): boolean {
  if (a === null || a.kind !== b.kind) return false;
  switch (b.kind) {
    case 'rest':
      return true;
    case 'buy':
      return a.kind === 'buy' && a.skill === b.skill;
    case 'target':
      return a.kind === 'target' && a.target.node === b.target.node;
  }
}

/**
 * The subject's macro-action for `branch`, then the other seats' turns until
 * the subject is to move again. A purchase leaves the turn with the subject
 * (Q190, 751), so after one nobody else plays.
 */
function realise(cursor: RolloutCursor, branch: MctsBranch, options: MctsOptions, rules: RolloutOptions): RolloutCursor {
  let after: RolloutCursor;
  if (branch.kind === 'buy') {
    return { ...cursor, state: applyAction(cursor.state, buyOf(branch, options), options.dice).state };
  }
  if (branch.kind === 'rest') {
    const rested = applyAction(cursor.state, { kind: 'rest', player: options.subject }, options.dice).state;
    after = { ...cursor, state: rested };
  } else {
    after = macroAdvanceToTarget(cursor, branch.target.node, rules, options.edgeRoute).cursor;
  }
  return playUntilTurnOf(after, options.subject, rules);
}

/**
 * The move a branch makes this turn: the first turn of its macro-action.
 *
 * [Q210] Stage 1 of Andrei's plan, 2026-10-02: "Keep simulated games as they
 * are, but switch the actual paths players walk to the most efficient". The
 * real move walks the best route for the subject's speeds, after anything it
 * bought this turn. Since stage 2 the search that chose the target counts the
 * best route too, and since stage 3 the games it imagines walk it.
 */
export function firstTurnOf(state: GameState, branch: MctsBranch | null, options: MctsOptions): TurnAction {
  if (branch === null) throw new RangeError('the search found no branch to take');
  if (branch.kind === 'buy') throw new RangeError('a purchase is not a move: plan the turn with planTurn');
  if (branch.kind === 'rest') return { kind: 'rest', player: options.subject };
  return turnTowards(state, branch.target.node, options.restRule, bestRouteForSpeeds);
}

/** What the subject does this turn: its purchases first, as one (`null` for none), then the move. */
export interface TurnPlan {
  readonly buy: BuyAction | null;
  /** `null` only when the purchases end the game (§1's win check, 756), leaving no move to make. */
  readonly action: TurnAction | null;
  /** The branch `action` is the first turn of; `null` with `action`. */
  readonly branch: Exclude<MctsBranch, { readonly kind: 'buy' }> | null;
}

/**
 * [Q190] 761: the computer thinks once a turn, then buys and moves. The plan
 * follows `treePolicy.bestChild` from the root through the buy branches it
 * picks, each a unit bought, to the first branch that is not one, whose first
 * turn is the move. The units are bought as one purchase, a line in the turn
 * log as a person's Done is (769). A purchase leaves the game as it was but for the buyer's
 * gold and the unit (no dice, nobody else plays), so the tree below a buy
 * branch was searched from exactly the position the plan reaches.
 *
 * Should the search have tried nothing yet below a purchase it picked, which
 * only a very short thinking time leaves, the rest of the plan comes from one
 * more round of search from there.
 */
export function planTurn(root: GameState, result: SearchResult, options: MctsOptions): TurnPlan {
  const skills: BuyAction['skills'][number][] = [];
  const bought = (): BuyAction | null => (skills.length === 0 ? null : { kind: 'buy', player: options.subject, skills });
  let state = root;
  let node = result.best;
  while (node.action?.kind === 'buy') {
    state = applyAction(state, buyOf(node.action, options), options.dice).state;
    skills.push(node.action.skill);
    if (state.status !== 'in_progress') return { buy: bought(), action: null, branch: null };
    node = node.children.length > 0 ? options.treePolicy.bestChild(node) : searchTree(state, { ...options, timeBudgetMs: 0 }).best;
  }
  const branch = node.action;
  if (branch === null) throw new RangeError('the search found no branch to take');
  return { buy: bought(), action: firstTurnOf(state, branch, options), branch };
}

function buyOf(branch: { readonly kind: 'buy'; readonly skill: BuyAction['skills'][number] }, options: MctsOptions): BuyAction {
  return { kind: 'buy', player: options.subject, skills: [branch.skill] };
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
