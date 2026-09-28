import type { GameConfig } from '@adventure/config';
import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import type { PoiCandidate, RestRule, RolloutCursor, RolloutTermination } from '@adventure/sim';

/**
 * One branch of the search tree.
 *
 * [SOURCE §9, review] Branches are POI targets, the most attractive of each
 * kind, plus resting, which is always a branch (Q65).
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
 * Which branches the tree expands at a node.
 *
 * [SOURCE §12.2, chat] "These POIs to explore will be the closest at the time
 * (among those that have not been claimed at that point of time in the
 * game)." So a branch is a *POI target*, recomputed at each node against that
 * node's own game state, and not a fixed list from the root.
 *
 * [SOURCE §9, review] Which POIs, since Q65: the `ATTRACTIVE_POIS_PER_KIND`
 * most attractive of each kind, plus rest. The same set is what a player in
 * the rollout picks from, so the tree and the rollout share one kernel,
 * `attractiveTargets` in `@adventure/sim`; only what they do with it differs —
 * the tree takes every target as a branch, the rollout picks one uniformly.
 *
 * `rng` settles ties for the last place of a kind (157).
 */
export interface ActionEnumerator {
  readonly name: string;
  enumerate(state: GameState, subject: PlayerId, rng: Rng): readonly MctsBranch[];
}

/**
 * The simulation phase.
 *
 * [SOURCE §9, review] Specified (Q65): each player "will choose randomly among
 * the same set of POI" the tree branches over, worked out for that player.
 * Swappable anyway, since the designer expects to experiment here.
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
