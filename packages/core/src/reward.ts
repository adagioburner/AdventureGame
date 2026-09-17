import type { GuardType, RewardKind } from '@adventure/config';

/**
 * [SOURCE §1.1, chat] "A POI's reward is always exactly one kind — reward
 * kinds are never mixed on the same POI. A POI can still hold multiple *units*
 * of its one kind."
 *
 * This is enforced **structurally, not by convention**: a `Reward` is a single
 * `{ kind, units }` pair. There is no array, no map keyed by kind, and no
 * union-of-rewards type anywhere in the codebase, so a mixed reward is not
 * expressible — a future contributor cannot create one by accident, and there
 * is no invariant check to forget.
 */
export interface Reward {
  readonly kind: RewardKind;
  /** Stack size. ≥ 1 — §4.3 step 2 guarantees every POI at least one unit. */
  readonly units: number;
}

/**
 * [SOURCE §1] A guard: "a red number (fighting-gated) or purple number
 * (magic-gated) beside the node, indicating guard strength, range 2–10".
 *
 * Deliberately independent of `Reward`: [SOURCE §1.1, chat] "The engine should
 * not hard-code 'gold only' — guarding should work on any reward kind — this
 * is a v1 content choice, not an engine constraint." Nothing in this package
 * inspects `Reward.kind` to decide whether a guard is permitted; which kinds
 * are guarded in v1 is expressed entirely by the §4.2 table in
 * `@adventure/config`.
 */
export interface Guard {
  readonly type: GuardType;
  /** Within `GUARD_STRENGTH` (§11): 2–10. */
  readonly strength: number;
}

/**
 * The `(kind, guard)` pair that identifies one row of the §4.2 table, i.e. one
 * *reward group* for the §4.3 assignment algorithm.
 *
 * Mountain gold is two groups — `gold/fighting` and `gold/magic` — sharing the
 * single `gold` kind. The guard type sub-partitions the gold group; it is not
 * an eighth reward kind, and `RewardKind` stays exactly the seven of §4.1.
 */
export interface RewardGroupKey {
  readonly kind: RewardKind;
  readonly guard: GuardType | null;
}

/** Stable string form of a group key, for grouping and for log messages. */
export function rewardGroupKeyOf(key: RewardGroupKey): string {
  return `${key.kind}/${key.guard ?? 'unguarded'}`;
}

export function sameRewardGroup(a: RewardGroupKey, b: RewardGroupKey): boolean {
  return a.kind === b.kind && a.guard === b.guard;
}
