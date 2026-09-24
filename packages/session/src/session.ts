import { NotImplementedError, type GameId, type GameMap, type UserId } from '@adventure/core';
import type { ClientMessage, ServerMessage, SetupState } from '@adventure/protocol';
import {
  GAME_MASTER_ABSENCE_BEHAVIOUR,
  type Broadcaster,
  type Clock,
  type GameDirectory,
  type GameListing,
  type GameStore,
} from './ports.ts';
import { applySetupAction, createSetup, SetupError, startGame, type NewSetup, type SetupLimits } from './setup.ts';

/**
 * The ports phase 6 uses. Phase 7 adds the server's dice (`DiceService`) and
 * the computer seats' moves (`AiService`), which is when this widens to
 * `SessionPorts`.
 */
export interface SetupSessionPorts {
  readonly games: GameStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly directory: GameDirectory;
}

/**
 * One live game. Single-writer by construction: every message for a game is
 * handled here, in order, so the authoritative state never needs locking.
 *
 * That single-writer shape is the main thing the hosting choice has to provide.
 * A Cloudflare Durable Object gives it for free (one object per `gameId`); a
 * Node process gives it with an in-process queue keyed by `gameId`. Either way
 * this class is unchanged — see `docs/STACK.md`.
 *
 * Responsibilities, and only these:
 *   - authority: is this user the game master (§7.3), is it this player's turn;
 *   - sequencing: apply one action at a time through `applyAction`;
 *   - driving AI turns via `AiService` when the active seat is AI-controlled;
 *   - persistence and broadcast through the ports.
 *
 * It contains no game rules. Movement, interaction, victory and turn order all
 * live in `@adventure/core`, so the server, the client's preview and MCTS all
 * agree by construction rather than by review. The setup flow's own rules are
 * `setup.ts`'s.
 */
export class GameSession {
  constructor(
    readonly gameId: GameId,
    private readonly ports: SetupSessionPorts,
    private readonly limits: SetupLimits,
  ) {}

  /** Creates the game in setup. Called once, by whoever made the `gameId`. */
  async create(game: Omit<NewSetup, 'gameId' | 'createdAt'>): Promise<SetupState> {
    if ((await this.ports.games.loadSetup(this.gameId)) !== null) {
      throw new SetupError('invalid_action', `game ${this.gameId} already exists`);
    }
    const setup = createSetup({ ...game, gameId: this.gameId, createdAt: this.ports.clock.now() }, this.limits);
    await this.ports.games.saveSetup(setup);
    await this.ports.directory.update(this.gameId, listingOf(setup));
    return setup;
  }

  /**
   * Someone opened the game: send them where it stands. A game master who
   * comes back while their Start is still waiting on the map is asked for it
   * again, so a reload in that moment cannot leave the game stuck.
   */
  async connected(user: UserId): Promise<void> {
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) {
      await this.ports.broadcaster.sendTo(user, notFound(this.gameId));
      return;
    }
    await this.ports.broadcaster.sendTo(user, { type: 'setup.state', setup });
    const game = await this.ports.games.load(this.gameId);
    if (game !== null) await this.ports.broadcaster.sendTo(user, { type: 'game.state', state: game });
    if (setup.phase === 'starting' && user === setup.gameMaster) await this.requestMap(setup);
  }

  /**
   * Handle one client message. Returns once the resulting state is persisted
   * and broadcast. A refused message is answered with an `error` to its sender
   * alone and changes nothing.
   *
   * [SOURCE §4] GM-only messages (`gm.*`, `setup.*`) are authorised here and
   * nowhere else — the engine deliberately does not know who the GM is.
   * [SOURCE §3, chat] The GM is the game's creator and the role cannot be
   * transferred, so this check is against a value fixed at creation.
   */
  async handle(from: UserId, message: ClientMessage): Promise<void> {
    try {
      await this.dispatch(from, message);
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      await this.ports.broadcaster.sendTo(from, { type: 'error', code: error.code, message: error.message });
    }
  }

  private async dispatch(from: UserId, message: ClientMessage): Promise<void> {
    if (message.type === 'lobby.create') {
      throw new SetupError('invalid_action', 'games are created from the game list');
    }
    if (message.gameId !== this.gameId) throw new SetupError('game_not_found', 'that message is for another game');
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) throw new SetupError('game_not_found', `there is no game ${this.gameId}`);

    switch (message.type) {
      case 'setup.requestJoin':
      case 'setup.withdraw':
      case 'setup.leave':
      case 'setup.updateSeat':
      case 'setup.setPlayerCount':
      case 'setup.respondToJoin':
      case 'setup.setSeed':
      case 'setup.setThinkingTime':
      case 'setup.cancel':
      case 'setup.start': {
        const outcome = applySetupAction(setup, from, message, this.limits, this.ports.clock.now());
        await this.ports.games.saveSetup(outcome.state);
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: outcome.state });
        if (outcome.declined !== undefined) {
          await this.ports.broadcaster.sendTo(outcome.declined, { type: 'setup.declined', gameId: this.gameId });
        }
        await this.ports.directory.update(this.gameId, listingOf(outcome.state));
        if (outcome.state.phase === 'starting') await this.requestMap(outcome.state);
        return;
      }

      case 'gm.mapGenerated': {
        if (from !== setup.gameMaster) throw new SetupError('not_game_master', 'only the game master sends the map');
        if (!looksLikeAMap(message.map)) throw new SetupError('invalid_action', 'that is not a map');
        const started = startGame(setup, message.map);
        await this.ports.games.save(started.game);
        await this.ports.games.saveSetup(started.setup);
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: started.setup });
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'game.state', state: started.game });
        await this.ports.directory.update(this.gameId, listingOf(started.setup));
        return;
      }

      default:
        // Turns, the board, GM controls and computer moves arrive in phase 7.
        throw new SetupError('invalid_action', 'online turns are not playable yet');
    }
  }

  /**
   * [SOURCE §4] Runs an AI seat's turn. Called when a turn starts on an
   * AI-controlled seat, including a seat an AI took over after a resignation.
   *
   * [Q48] Computer seats' online turns are phase 7's. The move is thought on
   * the game master's machine (§12.1) and arrives as `gm.aiMove`, so this
   * awaits a reply rather than computing anything.
   */
  runAiTurn(): Promise<void> {
    throw new NotImplementedError('GameSession.runAiTurn', 'GDD.md §9, §7.3');
  }

  /**
   * [SOURCE §4] "A human player may resign at any time; an AI takes over so
   * play continues."
   * [SOURCE §4, chat] "Only the game master can hand control back to a human
   * after a resignation — not self-service by the player." So resignation flips
   * `control` to `'ai'` and sets `resigned`, and the *only* route back is a
   * `gm.setControl` message, which this method does not provide.
   */
  resign(_player: UserId): Promise<void> {
    throw new NotImplementedError('GameSession.resign', 'GDD.md §7.3');
  }

  /**
   * [SOURCE §12.1, chat] The map is generated on the game master's machine.
   * [SOURCE §12.4, chat] With the GM gone nobody answers, and the game waits
   * in `starting` until they are back (`connected` asks again).
   */
  private async requestMap(setup: SetupState): Promise<void> {
    void GAME_MASTER_ABSENCE_BEHAVIOUR;
    await this.ports.broadcaster.sendTo(setup.gameMaster, {
      type: 'gm.requestMapGeneration',
      gameId: this.gameId,
      seed: setup.mapSeed,
    });
  }
}

/** The game list's row for a setup, or `null` once it is off the list. */
export function listingOf(setup: SetupState): GameListing | null {
  if (setup.phase === 'cancelled') return null;
  const people = setup.seats.filter((seat) => seat.userId !== null);
  return {
    gameId: setup.gameId,
    name: setup.name,
    gameMaster: setup.gameMaster,
    gameMasterName: setup.gameMasterName,
    phase: setup.phase === 'started' ? 'in_progress' : 'setup',
    seatsTaken: people.length,
    seatsTotal: setup.playerCount,
    createdAt: setup.createdAt,
    members: people.map((seat) => seat.userId).filter((id): id is UserId => id !== null),
  };
}

function notFound(gameId: GameId): ServerMessage {
  return { type: 'error', code: 'game_not_found', message: `there is no game ${gameId}` };
}

/** The shape `startGame` and the clients rely on; the rest is taken on trust. */
function looksLikeAMap(map: unknown): map is GameMap {
  if (typeof map !== 'object' || map === null) return false;
  const candidate = map as Partial<GameMap>;
  return (
    typeof candidate.seed === 'string' &&
    Array.isArray(candidate.graph?.nodes) &&
    Array.isArray(candidate.pois) &&
    candidate.poiByNode instanceof Map &&
    typeof candidate.ruleset === 'object'
  );
}
