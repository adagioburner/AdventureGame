/**
 * Closed vocabularies shared by the design tables.
 *
 * These live in `@adventure/config` rather than `@adventure/core` on purpose:
 * they are the axes that GDD.md's configuration table (§11) and reward table
 * (§4.2) are keyed by, and putting them here keeps the dependency graph acyclic
 * (`config` has no dependencies at all; `core` re-exports these names so domain
 * code can import them from `@adventure/core`).
 */

/** [SOURCE §1] Three terrain types. */
export const TERRAINS = ['plains', 'forest', 'mountain'] as const;
export type Terrain = (typeof TERRAINS)[number];

/**
 * [SOURCE §4.1] Seven reward kinds, one icon each. This union is closed and
 * exhaustive: a POI's reward is always exactly one of these (§3), never a
 * mixture. See `Reward` in `@adventure/core/reward` for how that is enforced
 * structurally rather than by convention.
 */
export const REWARD_KINDS = [
  'plains_move',
  'forest_move',
  'mountain_move',
  'fighting',
  'magic',
  'gold',
  'stamina',
] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

/**
 * [SOURCE §4.4] A guard is fighting-gated (red) or magic-gated (purple).
 * Guard type is a property of the *guard*, not of the reward kind — see the
 * note on `RewardGroupSpec` about why gold's guard split is a sub-partition of
 * the gold group and not an eighth reward kind.
 */
export const GUARD_TYPES = ['fighting', 'magic'] as const;
export type GuardType = (typeof GUARD_TYPES)[number];

/** A closed record over every terrain. */
export type PerTerrain<T> = Readonly<Record<Terrain, T>>;

/** An inclusive integer range, used for the several `MIN`/`MAX` rows of §11. */
export interface IntRange {
  readonly min: number;
  readonly max: number;
}
