/**
 * `@adventure/ai` — the MCTS player of GDD.md §9.
 *
 * §12.2 is now decided: the tree branches over every unclaimed POI the player
 * could take plus rest, opened a few at a time (Q64) in the order of Q62, and
 * everything else follows standard MCTS practice — UCT selection with √2,
 * most-visited child as the final move. Both ship here as named, swappable
 * defaults rather than as hard-coded behaviour, because the designer expects
 * to experiment with the evaluator and the policies alike.
 */
export * from './types.ts';
export * from './mcts.ts';
export * from './runner.ts';
export * from './computer.ts';
export { closestPoiRolloutPolicy, type ClosestPoiRolloutSettings } from './policies/rollout.ts';
export {
  uctTreePolicy,
  squareRootWidening,
  noWidening,
  sortedPoiEnumerator,
  orderKey,
  compareOrderKeys,
  journeyTo,
  winningOutcomes,
  dieOutcomes,
  type OrderKey,
} from './policies/tree.ts';
export {
  simulatedRolloutEvaluator,
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
} from './policies/evaluators.ts';
