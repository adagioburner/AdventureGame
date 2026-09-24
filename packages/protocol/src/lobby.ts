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
 * A seat on the setup screen. People hold the first seats, the game master in
 * seat 1 and the rest in the order the game master accepted them; computers
 * hold the seats nobody has taken ([Q48, 7 and 12]).
 */
export interface SetupSeat {
  /**
   * Who holds the seat, for as long as they hold it: `person:<userId>`, or
   * `computer:<n>` for a computer, whose `n` is never reused within a game.
   * Seat numbers move up when someone leaves or a computer makes way for a
   * person, so a change to a seat names it by this rather than by its number,
   * and a change aimed at a holder who has gone is refused instead of landing
   * on whoever holds that number now.
   */
  readonly id: string;
  readonly seat: Seat;
  readonly playerId: PlayerId;
  /** `null` for a computer seat. */
  readonly userId: UserId | null;
  readonly name: string;
  readonly avatarId: string;
  readonly control: ControlMode;
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
  /** The `n` the next computer seat's `id` gets. */
  readonly nextComputer: number;
  readonly pending: readonly JoinRequest[];
  /** [SOURCE §1.3] The map seed, so the whole map is reproducible from it. */
  readonly mapSeed: string;
  /** [Q48, 15] One thinking time for every computer seat, in whole seconds. */
  readonly thinkingSeconds: number;
}
