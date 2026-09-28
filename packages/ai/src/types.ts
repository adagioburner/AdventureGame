import type { GameConfig } from '@adventure/config';
import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import type { PoiCandidate, RestRule, RolloutCursor, RolloutTermination } from '@adventure/sim';

/**
 * One branch of the search tree.
 *
 * [SOURCE §9, review] Branches are POI targets, every unclaimed one the
 * player could take, plus resting, which is always a branch (Q62).
 */
export type MctsBranch =
  | { readonly kind: 'target'; readonly target: PoiCandidate }
  | { readonly kind: 'rest' };

/**
 * A node of the search tree: a decision point of the search's subject, reached
 * by the sequence of branches on the path from the root.
 *
 * A node holds no game state. The game has dice and the other seats move at
 * random in between, so the same branches lead to a different position each
 * time; every iteration replays them from the root through `applyAction` and
 * samples afresh. That is open-loop MCTS, the standard form for a game with
 * chance in it: were a node to keep the one position its first visit happened
 * to reach, a single lucky or unlucky roll would decide that branch's value for
 * the rest of the search.
 */
export interface MctsNode {
  /**
   * The branch taken from the parent; `null` at the root.
   *
   * [SOURCE §12.2/§9, chat] Taking a target branch is a **macro-action**: "the
   * simulated player keeps moving to the chosen POI without making new decision
   * until it's reached or claimed by a different player". So one edge of the
   * tree can span several turns, and `search()` returns only the *first* turn's
   * `TurnAction` from the branch it picks.
   */
  readonly action: MctsBranch | null;
  readonly parent: MctsNode | null;
  readonly children: MctsNode[];
  visits: number;
  /** Sum of backpropagated values; the evaluator decides what a value means. */
  totalValue: number;
}

/**
 * Selection down the tree.
 *
 * [SOURCE §12.2, chat] "For everything else please use sensible defaults that
 * are recommended for standard MCTS implementations." `uctTreePolicy()` is that
 * default: UCB1 selection with `MCTS_EXPLORATION_CONSTANT` (√2), and
 * most-visited-child as the final move rule.
 *
 * Still an interface, because the designer expects to experiment here as with
 * the evaluator — PUCT, ε-greedy, RAVE and a flat bandit all fit it unchanged.
 */
export interface TreePolicy {
  readonly name: string;
  /**
   * Pick among `available`: the children of `node` whose branch exists in the
   * position this iteration reached (a target another seat has claimed in this
   * sample is not one).
   */
  select(node: MctsNode, available: readonly MctsNode[], rng: Rng): MctsNode;
  /** Which child to return as the final move once the budget is spent. */
  bestChild(root: MctsNode): MctsNode;
}

/**
 * Which branches the tree has at a node, and which untried one it tries first.
 *
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q62), replacing §12.2's pruning to
 * the `CLOSE_CANDIDATE_COUNT` closest: "We will not prune any move choices.
 * Instead, we will rely on MCTS's internal balancing mechanisms between
 * exploration and deep search. We, however, will need to sort the move
 * candidates at each tree node of MCTS to make sure we first explore the most
 * promising ones."
 *
 * So `enumerate` lists every branch there is in the position — recomputed at
 * each node against that node's own game state, since the tree is open-loop —
 * and `firstToTry` says which of the ones this node has not tried yet comes
 * first. The search always expands that one, where it used to draw one at
 * random, and `Widening` says when (Q64); everything after expansion is UCT as
 * before.
 */
export interface ActionEnumerator {
  readonly name: string;
  enumerate(state: GameState, subject: PlayerId): readonly MctsBranch[];
  /** The first of `untried` in the order, ties broken with `rng`. `untried` is never empty. */
  firstToTry(state: GameState, subject: PlayerId, untried: readonly MctsBranch[], rng: Rng): MctsBranch;
}

/**
 * How many branches a node may have opened so far: progressive widening.
 *
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q64): with nothing pruned (Q62) a
 * node can have fifty branches or more, and trying each once before any twice
 * left the tree shallow and the order deciding only which came first. So a
 * node opens its branches one at a time in `ActionEnumerator.firstToTry`'s
 * order, as many as `openLimit` allows for the games that have passed through
 * it so far, and UCT shares the games among the open ones. A branch once
 * opened stays open (152), and when none of the open ones can be taken in the
 * position an iteration reached, the next one opens regardless (154).
 */
export interface Widening {
  readonly name: string;
  /** The most branches a node with `visits` games through it may have opened; at least 1. */
  openLimit(visits: number): number;
}

/**
 * The simulation phase.
 *
 * [SOURCE §5, chat] Specified: "choose a random target among the
 * `CLOSE_CANDIDATE_COUNT` closest POIs, using the same weighted-terrain-cost
 * random-walk code as §5.1." Swappable anyway, since the designer expects to
 * experiment here.
 */
export interface RolloutPolicy {
  readonly name: string;
  run(from: RolloutCursor, rng: Rng, dice: DiceSource): RolloutCursor;
}

/**
 * Turning a rolled-out state into the number that gets backpropagated.
 *
 * [SOURCE §5, chat] "Backpropagated value: the simulated player's gold amount
 * after rollout, **by default**. The tree-node evaluation function must be
 * easily swappable — a planned future experiment is a hybrid `average(gold
 * after simulation, gold now + (number of skills) × balancing_constant, at the
 * node being evaluated)`."
 *
 * [SOURCE §9, review] That `balancing_constant` form is superseded, and
 * the quote is kept for provenance only: the second term is now the *estimated*
 * evaluation, whose gold/skills weight moves with the game instead of being
 * tuned. See Q18 in `docs/OPEN_QUESTIONS.md`, and `policies/evaluators.ts` for
 * the three that ship — simulated, estimated and hybrid.
 *
 * The signature takes both the rolled-out cursor *and* the position at the
 * node being evaluated — where this iteration's rollout started — which is what
 * lets all three sit behind this one interface: the simulated one reads the
 * rollout, the estimated one reads the node, and the hybrid averages them.
 */
export interface NodeEvaluator {
  readonly name: string;
  evaluate(atNode: RolloutCursor, rolledOut: RolloutCursor, subject: PlayerId): number;
}

/** Everything `search()` needs. Every policy is injected; none has a default. */
export interface MctsOptions {
  readonly subject: PlayerId;
  readonly config: GameConfig;
  readonly treePolicy: TreePolicy;
  readonly actions: ActionEnumerator;
  readonly widening: Widening;
  readonly rollout: RolloutPolicy;
  readonly evaluator: NodeEvaluator;
  /**
   * [SOURCE §9, chat] Every seat is simulated by the same rollout policy, so
   * there is no separate opponent model to inject — only when to stop.
   */
  readonly termination: RolloutTermination;
  /**
   * When a player heading for a target rests instead. The same rule for tree
   * edges, rollouts and the move `search()` returns, so all three step alike.
   */
  readonly restRule: RestRule;
  /** The search's own die, never the game's: a search must not use up real rolls. */
  readonly dice: DiceSource;
  readonly rng: Rng;
  /** §11 `MCTS_TIME_BUDGET_PER_MOVE` — 10 s. */
  readonly timeBudgetMs: number;
  /** Injected clock, so search is testable and deterministic under a fake one. */
  readonly now: () => number;
}
