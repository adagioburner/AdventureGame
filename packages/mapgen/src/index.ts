/**
 * `@adventure/mapgen` — GDD.md §2.1's eight-step pipeline, §3's POI placement,
 * §4.3's reward assignment and §5.2's guard strengths.
 *
 * Runs headless and is deterministic in `(seed, ruleset)`, so the balancing
 * harness can generate thousands of maps offline and a server can regenerate
 * any map from its seed rather than storing geometry.
 */
export * from './types.ts';
export * from './graphops.ts';
export * from './pipeline.ts';
export * from './steps/index.ts';
export { distributionWeight, partitionPoisIntoGroups, distributeGroupUnits, assignRewards } from './rewards/assign.ts';
export { meetsCompactness } from './steps/5-smooth.ts';
export { guardStrengthFor, assignGuardStrengths } from './rewards/guards.ts';
