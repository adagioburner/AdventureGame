/**
 * `@adventure/sim` — the one random-walk implementation in the repo.
 *
 * [SOURCE §1.2, chat] "This random-walk code is shared with the AI player's
 * MCTS rollout policy (§9)." `candidates.ts` holds the ranking and the uniform
 * pick, `walk.ts` the loop, and `remoteness.ts` drives them.
 *
 * [SOURCE §9, review] Since Q65 the rollout no longer heads for the closest
 * POIs: `targets.ts` holds the most attractive of each kind, which the rollout
 * (`rollout.ts`) and the search tree in `@adventure/ai` both choose among.
 */
export * from './candidates.ts';
export * from './walk.ts';
export * from './remoteness.ts';
export * from './rollout.ts';
export * from './targets.ts';
