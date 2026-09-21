/**
 * `@adventure/sim` — the one random-walk implementation in the repo.
 *
 * [SOURCE §1.2, chat] "This random-walk code is shared with the AI player's
 * MCTS rollout policy (§9)." That sharing is structural here, not a comment:
 * `candidates.ts` holds the ranking and the uniform pick, `walk.ts` holds the
 * loop, and `remoteness.ts` / `rollout.ts` are two thin drivers over them.
 * Neither consumer contains a copy of the other's logic.
 */
export * from './candidates.ts';
export * from './walk.ts';
export * from './remoteness.ts';
export * from './rollout.ts';
