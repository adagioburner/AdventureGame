import { NotImplementedError, type GameId, type UserId } from '@adventure/core';
import type { SetupState } from '@adventure/protocol';
import type { SessionPorts } from './ports.ts';

/**
 * [SOURCE §3] §6.1's setup flow: the GM chooses player count, users request to
 * join, the GM accepts or rejects, each player picks a name and avatar, and the
 * GM starts the game.
 *
 * [SOURCE §2, chat] Seats are allocated in the order the GM accepts join
 * requests — "whatever is most convenient to implement" was the designer's
 * instruction, and acceptance order is both the expected default and free here.
 * Once `start()` runs, turn order is frozen for the rest of the game.
 *
 * [SOURCE §2, chat] Starting stamina is then `startingStaminaForSeat(seat)`
 * from `@adventure/config` — a formula over config, not a table, so raising
 * `PLAYER_COUNT.max` above 5 needs no further design input.
 */
export class SetupFlow {
  constructor(
    readonly gameId: GameId,
    private readonly ports: SessionPorts,
  ) {}

  state(): Promise<SetupState> {
    throw new NotImplementedError('SetupFlow.state', 'GDD.md §6.1');
  }

  /** GM-only. Must land within `PLAYER_COUNT` (§11). */
  setPlayerCount(_by: UserId, _count: number): Promise<void> {
    throw new NotImplementedError('SetupFlow.setPlayerCount', 'GDD.md §6.1');
  }

  requestJoin(_user: UserId, _name: string, _avatarId: string): Promise<void> {
    throw new NotImplementedError('SetupFlow.requestJoin', 'GDD.md §6.1');
  }

  /** GM-only. Accepting allocates the next seat, which fixes turn order. */
  respondToJoin(_by: UserId, _user: UserId, _accept: boolean): Promise<void> {
    throw new NotImplementedError('SetupFlow.respondToJoin', 'GDD.md §6.1');
  }

  /**
   * GM-only. Generates the map from `mapSeed` via `MapService` and builds the
   * initial `GameState`.
   *
   * **Blocked on a gap, not a stub**: GDD.md never says where players start on
   * the map. Seat order, starting stamina and turn order are all specified;
   * the starting node is not. See OPEN_QUESTIONS Q12 — this one has to be
   * answered before a game can actually begin.
   */
  start(_by: UserId): Promise<void> {
    throw new NotImplementedError(
      'SetupFlow.start — player starting positions are unspecified',
      'GDD.md §6 / docs/OPEN_QUESTIONS.md Q12',
    );
  }
}
