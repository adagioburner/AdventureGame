/**
 * `@adventure/core` — the domain model and the rules engine.
 *
 * Pure and dependency-free apart from `@adventure/config`: no I/O, no clock,
 * no `Math.random`. Everything stochastic takes an `Rng`; every die roll is
 * injected. That is what lets the identical code run in the browser (path
 * preview, hotseat), on the server (authoritative resolution), inside MCTS
 * rollouts and inside the balancing harness.
 */
export * from './errors.ts';
export * from './ids.ts';
export * from './rng.ts';
export * from './graph.ts';
export * from './reward.ts';
export * from './poi.ts';
export * from './messageboard.ts';
export * from './gamemap.ts';
export * from './player.ts';
export * from './path.ts';
export * from './state.ts';
export * from './action.ts';
export * from './rules/movement.ts';
export * from './rules/interaction.ts';
export * from './rules/turn.ts';
export * from './rules/victory.ts';

// Re-exported so domain code can import the shared vocabulary from one place.
export type { Terrain, RewardKind, GuardType, PerTerrain } from '@adventure/config';
export { TERRAINS, REWARD_KINDS, GUARD_TYPES } from '@adventure/config';
