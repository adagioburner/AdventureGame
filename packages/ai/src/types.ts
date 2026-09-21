import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import type { PoiCandidate, RolloutCursor, RolloutTermination } from '@adventure/sim';

/** A node of the search tree. One node per game state reached in the tree. */
/**
 * One branch of the search tree.
 *
 * [SOURCE §12.2, chat] Branches are POI targets, plus a rest branch when the
 * player has fewer than `MIN_REACHABLE_NODES_FOR_REST` targets reachable this
 * turn.
 */
export type MctsBranch =
  | { readonly kind: 'target'; readonly target: PoiCandidate }
  | { readonly kind: 'rest' };

export interface MctsNode {
  readonly state: GameState;
  /**
   * The branch that produced this state; `null` at the root.
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
  /** Branches not yet expanded from this node, per the `ActionEnumerator`. */
  readonly untried: MctsBranch[];
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
  select(node: MctsNode, rng: Rng): MctsNode;
  /** Which child to return as the final move once the budget is spent. */
  bestChild(root: MctsNode): MctsNode;
}

/**
 * Which branches the tree expands at a node.
 *
 * [SOURCE §12.2, chat] "We will prune the number of next POIs to be used to
 * expand any node to a value, MCTS_NODE_EXPANSION_PRUNING = 10 (to be tuned).
 * These 10 POIs to explore will be the closest at the time (among those that
 * have not been claimed at that point of time in the game)."
 *
 * So a branch is a *POI target*, recomputed at each node against that node's
 * own game state — "closest at the time", "not been claimed at that point in
 * time" — and not a fixed list from the root.
 *
 * This reuses `closestPoiCandidates` from `@adventure/sim`, the same ranking
 * the remoteness walk (§5.1) and the rollout policy (§9) use. Three callers,
 * one kernel; only K and what they do with the result differ.
 *
 * [SOURCE §12.2, chat] Rest is a branch too — "let us prune it if there are at
 * least MIN_REACHABLE_NODES_FOR_REST = 3 POIs reachable in one turn" — so the
 * rest branch appears only when the player is movement-constrained enough for
 * recovering stamina to be worth searching.
 */
export interface ActionEnumerator {
  readonly name: string;
  enumerate(state: GameState, subject: PlayerId): readonly MctsBranch[];
}

/**
 * "Reachable in one turn" for the rest-pruning rule — can this player actually
 * arrive at that target within this turn's allowance and stamina (§7)?
 *
 * Injected because it is the one part of the rule that needs `previewPath` from
 * `@adventure/core`, which is not written yet. The rule itself is.
 */
export interface TurnReachability {
  isReachableThisTurn(state: GameState, subject: PlayerId, target: PoiCandidate): boolean;
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
 * Note the signature takes both the rolled-out cursor *and* the node being
 * evaluated: the planned hybrid needs "gold now ... at the node being
 * evaluated", so an evaluator that only saw the rollout result could not
 * express it. Getting that right now is the whole point of making this a seam
 * before anything is implemented against it.
 */
export interface NodeEvaluator {
  readonly name: string;
  evaluate(node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number;
}

/** Everything `search()` needs. Every policy is injected; none has a default. */
export interface MctsOptions {
  readonly subject: PlayerId;
  readonly treePolicy: TreePolicy;
  readonly actions: ActionEnumerator;
  readonly rollout: RolloutPolicy;
  readonly evaluator: NodeEvaluator;
  /**
   * [SOURCE §9, chat] Every seat is simulated by the same rollout policy, so
   * there is no separate opponent model to inject — only when to stop.
   */
  readonly termination: RolloutTermination;
  readonly dice: DiceSource;
  readonly rng: Rng;
  /** §11 `MCTS_TIME_BUDGET_PER_MOVE` — 10 s. */
  readonly timeBudgetMs: number;
  /** Injected clock, so search is testable and deterministic under a fake one. */
  readonly now: () => number;
}
