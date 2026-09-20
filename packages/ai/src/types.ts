import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import type { OpponentRolloutPolicy, PoiCandidate, RolloutCursor, RolloutTermination } from '@adventure/sim';

/** A node of the search tree. One node per game state reached in the tree. */
export interface MctsNode {
  readonly state: GameState;
  /**
   * The POI this branch targets; `null` at the root.
   *
   * [SOURCE §12.2, chat] The tree branches over *POI targets*, not raw turn
   * actions — see `ActionEnumerator`. The chosen target is converted into a
   * concrete `TurnAction` only at the top, by `search()`.
   */
  readonly action: PoiCandidate | null;
  readonly parent: MctsNode | null;
  readonly children: MctsNode[];
  /** Targets not yet expanded from this node, per the `ActionEnumerator`. */
  readonly untried: PoiCandidate[];
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
 * Two things the answer does not settle, flagged rather than invented:
 *  - whether **rest** (§7's other turn action) is also a branch. It is not
 *    enumerated here, since the instruction speaks only of POIs, but a player
 *    who is out of stamina has nothing else to do. OPEN_QUESTIONS Q16.
 *  - whether targeting a POI is a **macro-action** (advance until arrival,
 *    possibly several turns) or one turn's step toward it. OPEN_QUESTIONS Q17.
 */
export interface ActionEnumerator {
  readonly name: string;
  enumerate(state: GameState, subject: PlayerId): readonly PoiCandidate[];
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
  readonly termination: RolloutTermination;
  readonly opponents: OpponentRolloutPolicy;
  readonly dice: DiceSource;
  readonly rng: Rng;
  /** §11 `MCTS_TIME_BUDGET_PER_MOVE` — 10 s. */
  readonly timeBudgetMs: number;
  /** Injected clock, so search is testable and deterministic under a fake one. */
  readonly now: () => number;
}
