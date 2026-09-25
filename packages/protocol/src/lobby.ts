import type { GameId, PlayerId, Seat, UserId } from '@adventure/core';
import type { ControlMode } from '@adventure/core';

/**
 * [SOURCE §3] What a logged-in user sees in the list of games.
 *
 * [Q48, 5] The list has two parts: the games you are in, waiting or started,
 * and the open games still waiting for players. Finished games are not listed.
 * A row is the same shape in both; `mine` says which part it belongs to.
 */
export interface GameSummary {
  readonly gameId: GameId;
  readonly name: string;
  readonly gameMaster: UserId;
  readonly gameMasterName: string;
  readonly phase: 'setup' | 'in_progress';
  /** Seats people have taken, the game master's included. */
  readonly seatsTaken: number;
  /** [Q51, 22] Seats for people: those taken and the Human seats still open. */
  readonly seatsTotal: number;
  readonly createdAt: number;
  /** Whether the user this row was sent to holds a seat in the game. */
  readonly mine: boolean;
}

/**
 * A user asking to be let in, with the name and figure they would play as
 * ([Q48, 10]). [SOURCE §3] The game master accepts or rejects.
 *
 * [Q49, 19] A request holds no figure: two requests may name the same one,
 * and a seated person may take it. A request whose figure a person holds
 * waits for its sender to pick another before it can be accepted.
 */
export interface JoinRequest {
  readonly userId: UserId;
  readonly requestedName: string;
  readonly requestedAvatarId: string;
  readonly requestedAt: number;
}

/**
 * A seat on the setup screen ([Q51, 22]). The game master holds seat 1. Every
 * other seat is Human or Computer, as the game master sets it: a Human seat is
 * kept for someone who asks to join, and accepting someone puts them in the
 * first Human seat nobody holds; a Human seat still empty at Start is played
 * by the computer ([Q48, 12]).
 *
 * So a seat is one of three things:
 *   - a person's: `control` human and `userId` theirs;
 *   - open: `control` human and `userId` null, with no name or figure yet;
 *   - a computer's: `control` ai and `userId` null.
 */
export interface SetupSeat {
  /**
   * Who holds the seat, for as long as they hold it: `person:<userId>`,
   * `computer:<n>` for a computer, or `open:<n>` for a Human seat nobody
   * holds; an `n` is never reused within a game. Seat numbers move up when a
   * seat is removed, so a change to a seat names it by this rather than by its
   * number, and a change aimed at a holder who has gone is refused instead of
   * landing on whoever holds that number now.
   */
  readonly id: string;
  readonly seat: Seat;
  readonly playerId: PlayerId;
  /** `null` for an open seat and a computer seat. */
  readonly userId: UserId | null;
  /** Empty for an open seat. */
  readonly name: string;
  /** Empty for an open seat. */
  readonly avatarId: string;
  readonly control: ControlMode;
  /** [Q51, 24] A computer seat's thinking time, whole seconds; kept but unused on a Human seat. */
  readonly thinkingSeconds: number;
}

/** Whether a seat is a Human seat nobody holds yet ([Q51, 22]). */
export function isOpenSeat(seat: SetupSeat): boolean {
  return seat.control === 'human' && seat.userId === null;
}

/**
 * [SOURCE §3] "A setup screen lets the game master choose player count, lets
 * other players join, and lets the game master accept or reject them. Each
 * player picks a name and avatar."
 *
 * [SOURCE §3, chat] The game master is whoever created the game on the portal,
 * and the role "cannot be transferred to anyone else in v1" — so `gameMaster`
 * is readonly for the whole life of the game and there is no transfer message
 * anywhere in this protocol. What happens when that person disappears is
 * §12.4; see `GAME_MASTER_ABSENCE_BEHAVIOUR` in `@adventure/session`.
 *
 * [SOURCE §2, chat] "Turn order fixed at game start, never changes thereafter
 * (order determined by whatever is most convenient to implement — expected
 * default: order the game master accepts join requests)." Seats are therefore
 * allocated in acceptance order, and `seat` is never rewritten once the game
 * has started.
 */
export interface SetupState {
  readonly gameId: GameId;
  /** [Q48, 6] Typed by the creator. */
  readonly name: string;
  readonly gameMaster: UserId;
  /** The game master's username, for the game list. */
  readonly gameMasterName: string;
  readonly createdAt: number;
  /**
   * `starting` is the moment between the game master pressing Start and their
   * browser sending the map (§12.1); `cancelled` is [Q48, 11]'s cancel before
   * the start.
   */
  readonly phase: 'setup' | 'starting' | 'started' | 'cancelled';
  /** Within `PLAYER_COUNT` (§11), never below the seats people hold. */
  readonly playerCount: number;
  /** Exactly `playerCount` of them, in seat order. */
  readonly seats: readonly SetupSeat[];
  /** The `n` the next computer or open seat's `id` gets. */
  readonly nextSeatId: number;
  readonly pending: readonly JoinRequest[];
  /** [SOURCE §1.3] The map seed, so the whole map is reproducible from it. */
  readonly mapSeed: string;
}
