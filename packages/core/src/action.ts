import type { RewardKind } from '@adventure/config';
import type { NodeId, PlayerId, Seat } from './ids.ts';
import type { ControlMode } from './player.ts';
import type { Reward } from './reward.ts';
import type { BoardPost } from './messageboard.ts';

/**
 * [SOURCE §2] "A turn is: move, then (if the turn ends on a POI) interact
 * automatically; or rest instead." Those are the only two things a player
 * chooses between, so the in-turn action space is exactly two variants — which
 * is also the action space the MCTS tree branches over (§9).
 */
export interface MoveAction {
  readonly kind: 'move';
  readonly player: PlayerId;
  /**
   * Nodes to enter, in order, excluding the player's current node.
   *
   * [SOURCE §7/§8, chat] **An empty path is legal** — "one can use it to fight
   * the same guard again". That is how §8's "remain stationed on the node" is
   * expressed: a turn with no movement still ends on a POI, so interaction
   * re-triggers and the player gets another roll against the guard.
   */
  readonly path: readonly NodeId[];
}

export interface RestAction {
  readonly kind: 'rest';
  readonly player: PlayerId;
}

/**
 * Rest and a zero-length move both leave the player where they are, but they
 * are **not** the same action, and the difference is a real decision for a
 * player camped on a guarded POI:
 *
 *  - zero-length move → interaction re-triggers, so another roll at the guard,
 *    and no stamina gained (§8);
 *  - rest → `REST_STAMINA_GAIN` stamina, and explicitly "no
 *    movement/interaction" (§7), so no roll.
 *
 * Each turn on that node is therefore a choice between another attempt and
 * recovering stamina, rather than both at once.
 */
export const ZERO_LENGTH_MOVE_PATH: readonly NodeId[] = [];

export type TurnAction = MoveAction | RestAction;

/**
 * [SOURCE §4] Game-master controls (§7.3) and resignation. These change game
 * state, so they live in the engine; *who is allowed to issue them* is decided
 * by the session layer, which is the only place that knows who the game master
 * is. The engine never checks authority.
 */
export interface SetControlAction {
  readonly kind: 'set_control';
  readonly player: PlayerId;
  readonly control: ControlMode;
}

export interface ResignAction {
  readonly kind: 'resign';
  readonly player: PlayerId;
}

/**
 * [SOURCE §4] "If a player takes too long, the game master can force their
 * currently-planned move (or force a rest, if none was planned."
 * [SOURCE §4, chat] No fixed threshold — entirely at the GM's discretion, so
 * there is no timer in the engine and none in config.
 */
export interface ForceTurnAction {
  readonly kind: 'force_turn';
  readonly player: PlayerId;
}

/**
 * [SOURCE §12.3, chat] The message board is game state, so posting to it is a
 * state change and therefore a `GameAction` — it goes through `applyAction`
 * like everything else rather than down a side channel.
 */
export interface PostMessageAction {
  readonly kind: 'post_message';
  readonly player: PlayerId;
  readonly body: string;
}

export type GameAction = TurnAction | SetControlAction | ResignAction | ForceTurnAction | PostMessageAction;

/** [SOURCE §2] One `GUARD_DIE` roll. Supplied by the caller — see `DiceSource`. */
export interface DieRoll {
  readonly value: number;
  readonly sides: number;
}

/** Outcome of walking a path: how far the player actually got, and the cost. */
export interface MovementResolution {
  readonly from: NodeId;
  readonly to: NodeId;
  /** The prefix of the requested path that was actually walked. */
  readonly walked: readonly NodeId[];
  /** [SOURCE §4] "walks to the destination or as far as it gets this turn". */
  readonly remainder: readonly NodeId[];
  readonly staminaSpent: number;
  readonly allowanceSpent: Readonly<Record<'plains' | 'forest' | 'mountain', number>>;
}

/** [SOURCE §2] Outcome of the automatic interaction on arriving at a POI. */
export interface InteractionResolution {
  readonly node: NodeId;
  /** `null` when the node holds no POI, or its reward was already claimed. */
  readonly reward: Reward | null;
  /** `null` when the POI was unguarded — no roll happens at all. */
  readonly roll: DieRoll | null;
  /** Which skill stat was added to the roll; `null` when unguarded. */
  readonly skillUsed: Extract<RewardKind, 'fighting' | 'magic'> | null;
  /**
   * True when the reward was taken. [SOURCE §2] On failure "the reward stays on
   * the node and the roll has no other cost" — there is no penalty field here
   * because there is no penalty.
   */
  readonly claimed: boolean;
}

/**
 * Everything that happened while applying one action, in order. The session
 * layer broadcasts these; the balancing harness and replays consume them.
 */
export type GameEvent =
  | { readonly type: 'moved'; readonly player: PlayerId; readonly resolution: MovementResolution }
  | { readonly type: 'rested'; readonly player: PlayerId; readonly staminaGained: number }
  | { readonly type: 'interacted'; readonly player: PlayerId; readonly resolution: InteractionResolution }
  | { readonly type: 'control_changed'; readonly player: PlayerId; readonly control: ControlMode }
  | { readonly type: 'resigned'; readonly player: PlayerId }
  | { readonly type: 'turn_ended'; readonly player: PlayerId; readonly nextSeat: Seat }
  | { readonly type: 'message_posted'; readonly post: BoardPost }
  | { readonly type: 'game_won'; readonly winners: readonly PlayerId[] };
