/**
 * `@adventure/ai` — the MCTS player of GDD.md §9.
 *
 * §12.2 is now decided: the tree branches over the `CLOSE_CANDIDATE_COUNT`
 * closest unclaimed POIs, and everything else follows standard MCTS practice —
 * UCT selection with √2, most-visited child as the final move. Both ship here
 * as named, swappable defaults rather than as hard-coded behaviour, because the
 * designer expects to experiment with the evaluator and the policies alike.
 */
export * from './types.ts';
export * from './mcts.ts';
export * from './runner.ts';
export * from './computer.ts';
export { closestPoiRolloutPolicy, type ClosestPoiRolloutSettings } from './policies/rollout.ts';
export {
  uctTreePolicy,
  closestUnclaimedPoiEnumerator,
  unclaimedPoiNodesOf,
  previewReachability,
} from './policies/tree.ts';
export {
  simulatedRolloutEvaluator,
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
} from './policies/evaluators.ts';
