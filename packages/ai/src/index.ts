/**
 * `@adventure/ai` — the MCTS player of GDD.md §9.
 *
 * Everything §9 specifies is implemented behind a named seam; everything §12.2
 * leaves open is an interface with no default implementation, so a build that
 * needs the tree policy fails loudly instead of quietly using someone's guess.
 */
export * from './types.ts';
export * from './mcts.ts';
export * from './runner.ts';
export { closestPoiRolloutPolicy } from './policies/rollout.ts';
export { goldAfterSimulationEvaluator, hybridGoldAndSkillsEvaluator } from './policies/evaluators.ts';
