import type { GameId, PlayerId, Seat, UserId } from '@adventure/core';
import type { ControlMode } from '@adventure/core';

/** [SOURCE §3] What a logged-in user sees in the list of in-progress games. */
export interface GameSummary {
  readonly gameId: GameId;
  readonly name: string;
  readonly gameMaster: UserId;
  readonly phase: 'setup' | 'in_progress' | 'finished';
  readonly seatsTaken: number;
  readonly seatsTotal: number;
  readonly createdAt: number;
}

/** A user asking to be let in. [SOURCE §3] The GM accepts or rejects. */
export interface JoinRequest {
  readonly userId: UserId;
  readonly requestedName: string;
  readonly requestedAvatarId: string;
  readonly requestedAt: number;
}

/** A seat in the setup screen, before the game starts. */
export interface SetupSeat {
  readonly seat: Seat;
  readonly playerId: PlayerId;
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
 * §12.4; see `GameMasterAbsencePolicy` in `@adventure/session`.
 *
 * [SOURCE §2, chat] "Turn order fixed at game start, never changes thereafter
 * (order determined by whatever is most convenient to implement — expected
 * default: order the game master accepts join requests)." Seats are therefore
 * allocated in acceptance order, and `seat` is never rewritten afterwards.
 */
export interface SetupState {
  readonly gameId: GameId;
  readonly gameMaster: UserId;
  /** Within `PLAYER_COUNT` (§11). Chosen by the GM. */
  readonly playerCount: number;
  readonly seats: readonly SetupSeat[];
  readonly pending: readonly JoinRequest[];
  /** [SOURCE §1.3] The map seed, so the whole map is reproducible from it. */
  readonly mapSeed: string;
  /** [SOURCE §intro] Hotseat runs every seat on one device; see §7.2. */
  readonly mode: 'online' | 'hotseat';
}
