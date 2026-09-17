/**
 * `@adventure/config` — every constant GDD.md §11 requires to live in config,
 * plus the §4.2 content tables, plus a clearly fenced-off set of
 * implementation-only knobs.
 *
 * Layering rule: this package has **no dependencies**. Everything else depends
 * on it. Nothing in the repo may inline a number that appears here.
 */
export * from './vocabulary.ts';
export * from './types.ts';
export { DEFAULT_GAME_CONFIG, DEFAULT_ENGINEERING_CONFIG } from './defaults.ts';
export { DEFAULT_GAME_CONTENT, DEFAULT_REWARD_TABLE } from './content.ts';
export { validateRuleset, resolvePending, RulesetError, UnresolvedDesignError } from './validate.ts';

import { DEFAULT_ENGINEERING_CONFIG, DEFAULT_GAME_CONFIG } from './defaults.ts';
import { DEFAULT_GAME_CONTENT } from './content.ts';
import type { Ruleset } from './types.ts';

/** The v1 ruleset: GDD.md §11 defaults + §4.2 content + engineering knobs. */
export const DEFAULT_RULESET: Ruleset = {
  config: DEFAULT_GAME_CONFIG,
  content: DEFAULT_GAME_CONTENT,
  engineering: DEFAULT_ENGINEERING_CONFIG,
};

/**
 * [SOURCE §2, chat] Starting stamina for a 1-based seat:
 * `STARTING_STAMINA_BASE + (seat − 1) × STARTING_STAMINA_INCREMENT`.
 *
 * Kept as a formula over config rather than a per-seat table so that raising
 * `PLAYER_COUNT.max` generalises with no further design input.
 */
export function startingStaminaForSeat(seat: number, ruleset: Ruleset): number {
  const { STARTING_STAMINA_BASE, STARTING_STAMINA_INCREMENT } = ruleset.config.players;
  return STARTING_STAMINA_BASE + (seat - 1) * STARTING_STAMINA_INCREMENT;
}
