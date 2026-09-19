import type { PerTerrain, RewardKind } from '@adventure/config';
import type { NodeId, PlayerId, Seat } from './ids.ts';

/**
 * [SOURCE §2] "Per-player stats, uncapped: stamina, plains/forest/mountain
 * moving skill levels, fighting skill, magic skill, gold."
 *
 * [INFERRED §2 / §4.1] Those seven stats are exactly the seven reward kinds of
 * §4.1, one for one. Typing the stat block as `Record<RewardKind, number>`
 * makes that correspondence structural: claiming a reward of kind K with N
 * units adds N to stat K, with no lookup table and no way for the two lists to
 * drift apart.
 *
 * Uncapped, so these are plain numbers with no clamping anywhere.
 */
export type PlayerStats = Readonly<Record<RewardKind, number>>;

/** [SOURCE §4] A player is driven by a human or by the MCTS AI (§9). */
export type ControlMode = 'human' | 'ai';

/**
 * [SOURCE §4] "Players may plan their next move out of turn while others play;
 * clicking 'End Turn' then executes it in one click. An unfinished path is
 * saved for the next turn and can still be changed."
 *
 * [SOURCE §intro, chat] Hotseat mode has no out-of-turn planning — the *field*
 * still exists there (an unfinished path is still carried over between that
 * player's own turns), but the client never lets a non-active player edit it.
 */
export interface PlannedPath {
  /** Nodes to walk, excluding the player's current node. */
  readonly path: readonly NodeId[];
  /** [SOURCE §4] Shift-click waypoint, when more than one path exists. */
  readonly waypoint: NodeId | null;
}

export interface PlayerState {
  readonly id: PlayerId;
  /** 1-based. [SOURCE §2, chat] Fixed at game start, never changes. */
  readonly seat: Seat;
  readonly name: string;
  /** Opaque to the engine; resolved to a figurine by the client (§10). */
  readonly avatarId: string;
  readonly control: ControlMode;
  /**
   * [SOURCE §4] A human may resign at any time; an AI takes over. Recorded
   * separately from `control` because only the game master may hand control
   * back to a human afterwards — not the player themselves.
   */
  readonly resigned: boolean;
  readonly stats: PlayerStats;
  readonly position: NodeId;
  readonly plannedPath: PlannedPath | null;
}

/**
 * [SOURCE §2] "a moving skill of level N lets a player step onto N nodes of
 * that terrain type per turn for free; the allowance refreshes every turn and
 * each terrain has its own independent allowance."
 */
export type MovementAllowance = PerTerrain<number>;

/** All stats start at zero except stamina, which is seat-dependent (§6). */
export function initialStats(startingStamina: number): PlayerStats {
  return {
    plains_move: 0,
    forest_move: 0,
    mountain_move: 0,
    fighting: 0,
    magic: 0,
    gold: 0,
    stamina: startingStamina,
  };
}
