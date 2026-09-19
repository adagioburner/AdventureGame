import type { GameConfig } from '@adventure/config';
import type { NodeId } from '@adventure/core';
import type { PoiAssignment } from '../types.ts';

/**
 * §5.2 — "`guard_strength + remoteness × REMOTENESS_WEIGHT ∝ reward`, where
 * `reward` is the gold amount being protected."
 *
 * [SOURCE §5.2, chat] Resolved into a concrete formula by the designer:
 *
 *   `guard_strength = amount_of_gold × GOLD_WEIGHT − remoteness × REMOTENESS_WEIGHT`
 *
 * capped between 0 and 10 (`GUARD_STRENGTH`), with `GOLD_WEIGHT = 3` to be
 * fine-tuned later. Direction of the derivation is forced by the pipeline: §4.3
 * has already fixed each POI's gold amount, so guard strength is the unknown.
 *
 * Two things this function deliberately does *not* do:
 *
 *  - **It never inspects the reward kind.** §4.4 requires that guarding work on
 *    any kind, "gold only" being a v1 content choice rather than an engine
 *    constraint, so the formula reads `assignment.units` — the POI's reward
 *    amount — not "the gold amount". For v1 content the two are identical,
 *    because the §4.2 table only ever guards gold.
 *  - **It does not round.** Remoteness is continuous in [0, 1], so the result
 *    is continuous too, and the designer specified a cap but no rounding rule.
 *    §8's `roll + skill > guard_strength` works either way; only the number §4.4
 *    displays beside the node is affected. See OPEN_QUESTIONS Q2a.
 *
 * A capped result of 0 means the POI ends up **unguarded** — [SOURCE §5.2, chat]
 * "1 gold with maximum remoteness is unguarded", which under these constants is
 * exactly `1 × 3 − 1 × 4 = −1`, capped to 0.
 */
export function guardStrengthFor(assignment: PoiAssignment, remoteness: number, config: GameConfig): number {
  const raw = assignment.units * config.balancing.GOLD_WEIGHT - remoteness * config.balancing.REMOTENESS_WEIGHT;
  const { min, max } = config.pois.GUARD_STRENGTH;
  return Math.min(max, Math.max(min, raw));
}

/**
 * Apply §5.2 to every POI the §4.2 table assigned a guard type.
 *
 * [SOURCE §1.1, chat] Which POIs carry a guard comes entirely from that table
 * (v1: every gold POI, nothing else), so this reads `guardType` and never the
 * reward kind.
 *
 * `guardStrength` stays `null` for an unguarded group. A POI whose formula
 * result caps at 0 keeps its `guardType` here but is sealed into the finished
 * map with `guard: null`, since a strength of 0 is what "unguarded" means.
 * That makes §4.4's "every gold POI is guarded, none are exempt" no longer hold
 * for low-gold, high-remoteness POIs — a knowing consequence of the formula,
 * not an engine decision.
 */
export function assignGuardStrengths(
  assignments: readonly PoiAssignment[],
  remoteness: ReadonlyMap<NodeId, number>,
  config: GameConfig,
): void {
  for (const assignment of assignments) {
    if (assignment.guardType === null) {
      assignment.guardStrength = null;
      continue;
    }
    const score = remoteness.get(assignment.node);
    if (score === undefined) {
      throw new RangeError(`no remoteness score for POI node ${assignment.node}`);
    }
    assignment.guardStrength = guardStrengthFor(assignment, score, config);
  }
}
