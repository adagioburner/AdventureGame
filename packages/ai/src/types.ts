import type { DiceSource, GameState, PlayerId, Rng, TurnAction } from '@adventure/core';
import type { OpponentRolloutPolicy, RolloutCursor, RolloutTermination } from '@adventure/sim';

/** A node of the search tree. One node per game state reached in the tree. */
export interface MctsNode {
  readonly state: GameState;
  /** The action that produced this state; `null` at the root. */
  readonly action: TurnAction | null;
  readonly parent: MctsNode | null;
  readonly children: MctsNode[];
  /** Actions not yet expanded from this node, per the `ActionEnumerator`. */
  readonly untried: TurnAction[];
  visits: number;
  /** Sum of backpropagated values; the evaluator decides what a value means. */
  totalValue: number;
}

/**
 * Selection down the tree — **the open item**.
 *
 * [OPEN §12.2 / §11 last row] "The tree/selection policy (e.g. the
 * exploration-vs-exploitation formula) is unspecified."
 *
 * The interface is all that can honestly be written: given a node whose
 * children are all expanded, choose one. UCT, PUCT, ε-greedy, RAVE and a flat
 * bandit all fit this shape unchanged, so committing to the interface commits
 * to nothing about the answer. **No implementation ships in this package** —
 * `@adventure/config`'s `pending.MCTS_TREE_POLICY` is the matching hole, and
 * `search()` requires one to be supplied.
 */
export interface TreePolicy {
  readonly name: string;
  select(node: MctsNode, rng: Rng): MctsNode;
  /** Which child to return as the final move once the budget is spent. */
  bestChild(root: MctsNode): MctsNode;
}

/**
 * Which actions the tree branches over at a node.
 *
 * Also unspecified. §9 gives the *rollout* policy (random target among the K
 * closest POIs) but says nothing about the tree's branching factor, and the two
 * need not match — the legal action set at a node is "rest, or move along any
 * path", which is far too wide to enumerate directly. Whatever answers §12.2
 * will almost certainly answer this at the same time, so it is a seam with no
 * default rather than a separate invention. See OPEN_QUESTIONS Q10.
 */
export interface ActionEnumerator {
  readonly name: string;
  enumerate(state: GameState, subject: PlayerId): readonly TurnAction[];
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
