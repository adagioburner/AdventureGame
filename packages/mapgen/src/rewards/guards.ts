import type { GameConfig } from '@adventure/config';
import { NotImplementedError } from '@adventure/core';
import type { PoiAssignment } from '../types.ts';

/**
 * §5.2 — "`guard_strength + remoteness × REMOTENESS_WEIGHT ∝ reward`, where
 * `reward` is the gold amount being protected."
 *
 * Direction of the derivation is forced by the pipeline: §4.3 has already fixed
 * each POI's gold amount, so guard strength is the unknown and is solved for.
 *
 * What is **not** given is the constant of proportionality, nor how the real
 * number it produces becomes an integer inside `GUARD_STRENGTH` (2–10):
 * rounding, and what to do when the formula lands outside the range — clamp, or
 * reject and redistribute. Reading §5.2's own anchor as a literal equation
 * (1 gold ↔ 4) makes a 10-gold POI want strength 40, so *something* has to give,
 * and which is a design call.
 *
 * Hence `GUARD_STRENGTH_SCALE` is a pending config value that throws on read.
 * See OPEN_QUESTIONS Q2.
 */
export function guardStrengthFor(
  _assignment: PoiAssignment,
  _remoteness: number,
  _config: GameConfig,
  _scale: number,
): number {
  throw new NotImplementedError('guardStrengthFor', 'GDD.md §5.2 / docs/OPEN_QUESTIONS.md Q2');
}

/**
 * Apply §5.2 to every guarded POI.
 *
 * [SOURCE §1.1, chat] Which POIs are guarded comes entirely from the §4.2 table
 * (v1: every gold POI, nothing else). This function reads `guardType` from the
 * assignment and never inspects the reward kind — §4.4 requires that guarding
 * work on any kind, so "gold only" must not appear in the engine.
 */
export function assignGuardStrengths(
  _assignments: readonly PoiAssignment[],
  _config: GameConfig,
  _scale: number,
): void {
  throw new NotImplementedError('assignGuardStrengths', 'GDD.md §4.4, §5.2');
}
