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
 * [SOURCE §5.2, chat] Two anchors were supplied to pin the scale: "1 gold with
 * maximum remoteness is unguarded; the maximum gold with maximum remoteness has
 * maximum guard strength (10). The other guard values are distributed
 * proportionally within this range."
 *
 * **Still unimplemented, because those two anchors cannot both hold.** Writing
 * §5.2 as an equation, `guard = k × gold − remoteness × W`:
 *
 *   anchor A (1 gold, r = 1, guard 0):      0 = k × 1 − 4       →  k = 4
 *   anchor B (G_max gold, r = 1, guard 10): 10 = k × G_max − 4  →  k × G_max = 14
 *
 * Together those require `G_max = 3.5`. The largest gold stack one POI can hold
 * is an integer in [2, 11] (from §4.2's rows plus §4.3's baseline-then-
 * distribute), so it is never 3.5 and the two anchors are inconsistent under
 * strict proportionality.
 *
 * Satisfying both anchors instead needs a non-zero intercept, e.g.
 * `guard = 10 × (gold − 1)/(G_max − 1) + (1 − r) × W`. That hits both anchors
 * exactly, but then difficulty runs 4 → 14 across the whole gold range, a ratio
 * of 3.5 regardless of `G_max` — so difficulty is no longer *proportional* to
 * gold, and §5.2's `∝` becomes an approximation.
 *
 * So the choice is: keep §5.2's proportionality, or keep both anchors. Either
 * way a third problem remains — since guard *decreases* with remoteness (§5.2's
 * trade-off), anchor B describes max gold at its least-guarded remoteness, so
 * any less-remote max-gold POI wants 14, above `GUARD_STRENGTH.max` of 10.
 *
 * See OPEN_QUESTIONS Q2 for the follow-up put to the designer, including
 * whether `G_max` is a config cap or the observed per-map maximum, and how
 * "unguarded" (0) relates to `GUARD_STRENGTH.min` of 2 and §4.4's "every gold
 * POI is guarded, none are exempt".
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
