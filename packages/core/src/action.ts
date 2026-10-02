import type { RewardKind } from '@adventure/config';
import type { NodeId, PlayerId, Seat } from './ids.ts';
import type { ControlMode, PlannedPath } from './player.ts';
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
  /**
   * [SOURCE §4] The shift-click waypoint the path was planned through, if any.
   * The engine walks `path` and nothing else; the waypoint only rides along
   * into the saved remainder, so that a route cut short this turn still shows
   * its waypoint next turn and "can still be changed" around it. Omitted, the
   * player's already-saved waypoint is kept, which is what a forced move wants.
   */
  readonly waypoint?: NodeId | null;
}

export interface RestAction {
  readonly kind: 'rest';
  readonly player: PlayerId;
  /**
   * [Andrei, 2026-09-30, 490] End turn with a route whose first step this turn
   * cannot pay rests instead (`endTurnActionFor`), and the route is saved for
   * next turn as a walk cut short saves its remainder. [Andrei, 2026-10-01]
   * Rest on one device carries the route shown the same way, since nothing
   * else saves it there, and an empty one after Cancel (610), which saves
   * none. Omitted, the saved route stays as it was.
   */
  readonly plan?: PlannedPath;
}

/**
 * [SOURCE §7, chat] "Resting means taking no action, including no interaction
 * with a POI, so it is different."
 *
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
 * [Q190] Andrei, 2026-10-02: "allow players buy skills for gold, 1 to 1."
 * A unit of each of `skills` for `GOLD_PER_UNIT` gold apiece, on the player's
 * own turn before they end it (754), as often as their gold pays for (751,
 * Free). It is not a turn: the turn goes on, and still ends with a move or a
 * rest. A speed bought counts this turn too (752); nothing bought is sold
 * back (755).
 *
 * One action is what a person picked in the buy panel before pressing Done
 * (768), so the turn log has a line for it (769); the computer's are its
 * purchases for the turn (761). All of it is bought or, should the gold fall
 * short, none.
 */
export interface BuyAction {
  readonly kind: 'buy';
  readonly player: PlayerId;
  /** One entry per unit, each one of the game's `buying.KINDS`: a speed, combat or magic. */
  readonly skills: readonly RewardKind[];
}

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
  /**
   * [Andrei, 2026-09-30, 491] Set when Move on rests because the saved route's
   * first step cannot be paid this turn and no guard stands on the player's
   * space: Move on plays what End turn would (`moveOnActionFor`). It is
   * carried on the action rather than worked out again from the state so
   * that games played before, whose Move on walked nothing there, still
   * replay as they were played.
   */
  readonly rest?: true;
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
  /**
   * The post's identity and timestamp are supplied by the caller, because the
   * engine has no clock and no id source — it is pure and deterministic, and
   * `Clock` is a session-layer port for exactly this reason. So the session
   * stamps a post as it builds the action, and `applyAction` only appends it,
   * which also keeps a replayed game's board identical to the original's.
   */
  readonly id: string;
  readonly postedAt: number;
}

/**
 * [Q85, 298 and 299] The game master deletes a post, for when someone posts
 * something inappropriate: it keeps its place, author and time on the board,
 * and its words are erased. Who may is the session layer's to decide; the
 * session also erases the words from the post's own stored record, so no
 * replay brings them back.
 */
export interface DeleteMessageAction {
  readonly kind: 'delete_message';
  /** The post's `BoardPost.id`. */
  readonly id: string;
}

/**
 * [SOURCE §4] "Players may plan their next move out of turn while others play
 * [...] An unfinished path is saved for the next turn and can still be
 * changed."
 *
 * Online, the route a player draws is saved as they draw it, whoever's turn it
 * is, so that their own End Turn and the game master's forced move (§7.3) play
 * the same route, and a reload or another device shows it again. An empty path
 * clears the saved route. It is not a turn: it neither ends one nor waits for
 * one.
 */
export interface PlanAction {
  readonly kind: 'plan';
  readonly player: PlayerId;
  /** Nodes to walk, excluding the player's current node; each adjacent to the last. */
  readonly path: readonly NodeId[];
  /** The waypoint the route was drawn through; on the path, or `null`. */
  readonly waypoint: NodeId | null;
}

/**
 * How a game can end other than by §1's win.
 *
 * [Q55, 45] "Time running out mid-game: the game ends and the player holding
 * the most gold wins, a tie shared." [Q55, 40] The game master can end a game
 * in progress, and [Q85, 291] then too the most gold wins, a tie shared.
 */
export type GameEndReason = 'time_out' | 'game_master';

/** How a finished game ended: §1's win, or one of `GameEndReason`. */
export type GameEnding = 'won' | GameEndReason;

export interface EndGameAction {
  readonly kind: 'end_game';
  readonly reason: GameEndReason;
}

export type GameAction =
  | TurnAction
  | BuyAction
  | SetControlAction
  | ResignAction
  | ForceTurnAction
  | PostMessageAction
  | DeleteMessageAction
  | PlanAction
  | EndGameAction;

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
  | { readonly type: 'message_deleted'; readonly id: string }
  | { readonly type: 'planned'; readonly player: PlayerId; readonly plan: PlannedPath | null }
  /** [Q190] A player bought a unit of each of `skills` for `gold` gold in all, during their turn. */
  | { readonly type: 'bought'; readonly player: PlayerId; readonly skills: readonly RewardKind[]; readonly gold: number }
  /** [Q135] A speed or skill ran short and came back to an empty site, far from every figure. */
  | { readonly type: 'reward_returned'; readonly node: NodeId; readonly reward: Reward }
  | { readonly type: 'game_won'; readonly winners: readonly PlayerId[] }
  | { readonly type: 'game_ended'; readonly reason: GameEndReason; readonly winners: readonly PlayerId[] };
