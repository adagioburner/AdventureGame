import {
  activePlayer,
  applyAction,
  RuleViolationError,
  type ActionOutcome,
  type DieRoll,
  type GameAction,
  type GameId,
  type GameMap,
  type GameState,
  type PlayerId,
  type TurnAction,
  type UserId,
} from '@adventure/core';
import {
  BOARD_POST_MAX,
  computerMoveRequestId,
  DAY_MS,
  RESIGNED_THINKING_SECONDS,
  isOpenSeat,
  KEPT_AFTER_END_DAYS,
  LONGEST_LIFETIME_DAYS,
  type ClientMessage,
  type GameRecord,
  type ServerMessage,
  type SetupState,
} from '@adventure/protocol';
import { GAME_MASTER_ABSENCE_BEHAVIOUR, type GameListing, type SessionPorts } from './ports.ts';
import { applySetupAction, createSetup, SetupError, startGame, type NewSetup, type SetupLimits } from './setup.ts';

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
 *   - sequencing: apply one action at a time through `applyAction`, with the
 *     server's own dice, and keep a record of each;
 *   - driving AI turns by asking the game master's browser for them when the
 *     active seat is AI-controlled (§12.1);
 *   - the game's lifetime ([Q55]): ending it when its time is up, and
 *     deleting it a week after it closed, whenever its host wakes it;
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
    private readonly ports: SessionPorts,
    private readonly limits: SetupLimits,
  ) {}

  /** Creates the game in setup. Called once, by whoever made the `gameId`. */
  async create(game: Omit<NewSetup, 'gameId' | 'createdAt'>): Promise<SetupState> {
    if ((await this.ports.games.loadSetup(this.gameId)) !== null) {
      throw new SetupError('invalid_action', `game ${this.gameId} already exists`);
    }
    const setup = createSetup({ ...game, gameId: this.gameId, createdAt: this.ports.clock.now() }, this.limits);
    await this.ports.games.saveSetup(setup);
    await this.ports.directory.update(this.gameId, listingOf(setup, null));
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
      await this.ports.broadcaster.sendTo(user, (await this.ports.games.isRemoved(this.gameId)) ? removed() : notFound(this.gameId));
      return;
    }
    await this.ports.broadcaster.sendTo(user, { type: 'setup.state', setup });
    const game = await this.ports.games.load(this.gameId);
    if (game !== null) {
      await this.ports.broadcaster.sendTo(user, { type: 'game.state', state: game });
      await this.ports.broadcaster.sendTo(user, {
        type: 'game.history',
        gameId: this.gameId,
        records: await this.ports.games.loadRecords(this.gameId),
      });
    }
    if (setup.phase === 'starting' && user === setup.gameMaster) await this.requestMap(setup);
    // [SOURCE §12.4] A computer's turn waits for the game master; asked again when they are back.
    if (game !== null && user === setup.gameMaster) await this.requestAiMove(setup, game);
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
      case 'setup.updateRequest':
      case 'setup.withdraw':
      case 'setup.leave':
      case 'setup.updateSeat':
      case 'setup.setPlayerCount':
      case 'setup.respondToJoin':
      case 'setup.setSeed':
      case 'setup.rename':
      case 'setup.setSeatControl':
      case 'setup.setThinkingTime':
      case 'setup.cancel':
      case 'setup.start':
      case 'setup.setLifetime': {
        const outcome = applySetupAction(setup, from, message, this.limits, this.ports.clock.now());
        await this.ports.games.saveSetup(outcome.state);
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: outcome.state });
        if (outcome.declined !== undefined) {
          await this.ports.broadcaster.sendTo(outcome.declined, { type: 'setup.declined', gameId: this.gameId });
        }
        await this.ports.directory.update(this.gameId, listingOf(outcome.state, null));
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
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'game.history', gameId: this.gameId, records: [] });
        await this.ports.directory.update(this.gameId, listingOf(started.setup, started.game));
        await this.requestAiMove(started.setup, started.game);
        return;
      }

      case 'turn.plan': {
        // [SOURCE §4] Any time during play, the sender's own seat only.
        const game = await this.gameInProgress();
        const player = humanPlayerOf(setup, game, from);
        await this.play(setup, game, { kind: 'plan', player, path: message.path, waypoint: message.waypoint }, from);
        return;
      }

      case 'turn.end':
      case 'turn.rest': {
        const game = await this.gameInProgress();
        const player = humanPlayerOf(setup, game, from);
        requireTurn(game, message.turn);
        if (activePlayer(game).id !== player) throw new SetupError('not_your_turn', `it is ${activePlayer(game).name}’s turn`);
        const action: TurnAction =
          message.type === 'turn.rest'
            ? { kind: 'rest', player }
            : { kind: 'move', player, path: message.path, waypoint: message.path.length === 0 ? null : message.waypoint };
        await this.play(setup, game, action, from);
        return;
      }

      case 'gm.forceTurn': {
        // [SOURCE §4] At the game master's discretion, with no time limit.
        if (from !== setup.gameMaster) throw new SetupError('not_game_master', 'only the game master can move a player on');
        const game = await this.gameInProgress();
        requireTurn(game, message.turn);
        const active = activePlayer(game);
        if (active.id !== message.player) throw new SetupError('not_your_turn', `it is ${active.name}’s turn now`);
        if (active.control !== 'human') throw new SetupError('invalid_action', `${active.name} is played by the computer`);
        await this.play(setup, game, { kind: 'force_turn', player: active.id }, from);
        return;
      }

      case 'gm.aiMove': {
        // [SOURCE §12.1] A computer's move, thought on the game master's page.
        // An answer to a turn that is over (a second device of theirs, a
        // reload) changes nothing and needs no reply.
        if (from !== setup.gameMaster) throw new SetupError('not_game_master', 'only the game master sends computer moves');
        const game = await this.ports.games.load(this.gameId);
        if (game === null || game.status !== 'in_progress' || message.requestId !== computerMoveRequestId(game)) return;
        const active = activePlayer(game);
        if (active.control !== 'ai' || message.player !== active.id) return;
        const action = message.action;
        if ((action.kind !== 'move' && action.kind !== 'rest') || action.player !== active.id) {
          throw new SetupError('invalid_action', 'that is not a move for the computer on turn');
        }
        await this.play(setup, game, action, from);
        return;
      }

      case 'gm.endGame': {
        if (from !== setup.gameMaster) throw new SetupError('not_game_master', 'only the game master can end the game');
        const game = await this.gameInProgress();
        await this.play(setup, game, { kind: 'end_game', reason: 'game_master' }, from);
        return;
      }

      case 'gm.extendLifetime': {
        // [Q55, 44] A day at a time, up to 14 days from creation, until it ends.
        if (from !== setup.gameMaster) throw new SetupError('not_game_master', 'only the game master can extend the game');
        if (setup.closedAt !== null || setup.phase === 'cancelled' || setup.phase === 'expired') {
          throw new SetupError('invalid_action', 'the game has ended');
        }
        const longest = setup.createdAt + LONGEST_LIFETIME_DAYS * DAY_MS;
        if (setup.endsAt >= longest) {
          throw new SetupError('invalid_action', `a game lasts at most ${LONGEST_LIFETIME_DAYS} days`);
        }
        const extended: SetupState = { ...setup, endsAt: Math.min(longest, setup.endsAt + DAY_MS) };
        await this.ports.games.saveSetup(extended);
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: extended });
        await this.ports.directory.update(this.gameId, listingOf(extended, await this.ports.games.load(this.gameId)));
        return;
      }

      case 'player.resign': {
        // [Q56, 57] Anyone holding a seat, the game master included. The
        // computer plays it from then on; only the game master can hand it
        // back, which is phase 8.
        const game = await this.gameInProgress();
        const player = humanPlayerOf(setup, game, from);
        const resigned: SetupState = {
          ...setup,
          seats: setup.seats.map((seat) => (seat.playerId === player ? { ...seat, thinkingSeconds: RESIGNED_THINKING_SECONDS } : seat)),
        };
        await this.ports.games.saveSetup(resigned);
        await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: resigned });
        await this.play(resigned, game, { kind: 'resign', player }, from);
        return;
      }

      case 'board.post': {
        // [Q56, 59] Anyone holding a seat, resigned or not, from Start until the
        // game is removed, after it ends too. The computer never posts.
        const game = await this.ports.games.load(this.gameId);
        if (game === null) throw new SetupError('invalid_action', 'the board opens when the game starts');
        const seat = setup.seats.find((candidate) => candidate.userId === from);
        if (seat === undefined) throw new SetupError('invalid_action', 'only the players in this game can post');
        const body = message.body.trim();
        if (body.length === 0) throw new SetupError('invalid_action', 'a post needs some words');
        if ([...body].length > BOARD_POST_MAX) throw new SetupError('invalid_action', `a post is at most ${BOARD_POST_MAX} characters`);
        const postedAt = this.ports.clock.now();
        const id = `post-${game.messageBoard.length + 1}`;
        await this.play(setup, game, { kind: 'post_message', player: seat.playerId, body, id, postedAt }, from);
        return;
      }

      default:
        // Switching a seat between person and computer is the game master's in phase 8.
        throw new SetupError('invalid_action', 'that is not playable yet');
    }
  }

  /**
   * [Q55] When the host must wake this game next: its lifetime running out, or
   * its deletion a week after it closed. `null` once there is nothing left to do.
   */
  async nextDeadline(): Promise<number | null> {
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) return null;
    return setup.closedAt === null ? setup.endsAt : setup.closedAt + KEPT_AFTER_END_DAYS * DAY_MS;
  }

  /**
   * The host woke the game (a Cloudflare alarm): end it if its time is up
   * ([Q55, 42 and 45]), or delete it if it closed a week ago ([Q55, 37]).
   */
  async wake(): Promise<void> {
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) return;
    const now = this.ports.clock.now();

    if (setup.closedAt !== null) {
      if (now < setup.closedAt + KEPT_AFTER_END_DAYS * DAY_MS) return;
      await this.ports.games.remove(this.gameId);
      await this.ports.directory.update(this.gameId, null);
      await this.ports.broadcaster.broadcast(this.gameId, removed());
      return;
    }
    if (now < setup.endsAt) return;

    const game = await this.ports.games.load(this.gameId);
    if (game !== null) {
      // Started: in progress it ends on time; finished, it only waits for its deletion.
      if (game.status === 'in_progress') await this.play(setup, game, { kind: 'end_game', reason: 'time_out' }, null);
      return;
    }
    // [Q55, 42] A game that never started also goes when its time is up.
    const expired: SetupState = { ...setup, phase: 'expired', pending: [], closedAt: now };
    await this.ports.games.saveSetup(expired);
    await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: expired });
    await this.ports.directory.update(this.gameId, listingOf(expired, null));
  }

  /**
   * Applies one action to the game with the server's dice, keeps its record,
   * stores and sends it, and moves the game on: the list's row, a computer's
   * turn to ask for, the game closing when it has finished.
   */
  private async play(setup: SetupState, game: GameState, action: GameAction, by: UserId | null): Promise<void> {
    const dice = await this.ports.dice.forGame(this.gameId);
    const rolls: DieRoll[] = [];
    let outcome: ActionOutcome;
    try {
      outcome = applyAction(game, action, {
        roll: () => {
          const roll = dice.roll();
          rolls.push(roll);
          return roll;
        },
      });
    } catch (error) {
      if (error instanceof RuleViolationError) throw new SetupError('invalid_action', error.message);
      throw error;
    }
    const now = this.ports.clock.now();
    const record: GameRecord = await this.ports.games.appendRecord(this.gameId, { action, rolls, at: now, by });
    await this.ports.games.save(outcome.state);

    let current = setup;
    if (outcome.state.status === 'finished' && setup.closedAt === null) {
      current = { ...setup, closedAt: now };
      await this.ports.games.saveSetup(current);
      await this.ports.broadcaster.broadcast(this.gameId, { type: 'setup.state', setup: current });
    }
    await this.ports.broadcaster.broadcast(this.gameId, { type: 'game.played', gameId: this.gameId, record });

    const before = listingOf(setup, game);
    const after = listingOf(current, outcome.state);
    if (JSON.stringify(before) !== JSON.stringify(after)) await this.ports.directory.update(this.gameId, after);
    // A new turn, or a resignation handing the turn on to the computer.
    if (outcome.state.turn.number !== game.turn.number || action.kind === 'resign') await this.requestAiMove(current, outcome.state);
  }

  private async gameInProgress(): Promise<GameState> {
    const game = await this.ports.games.load(this.gameId);
    if (game === null) throw new SetupError('invalid_action', 'the game has not started');
    if (game.status !== 'in_progress') throw new SetupError('invalid_action', 'the game is over');
    return game;
  }

  /**
   * [SOURCE §12.1] Asks the game master's browser for the move of the
   * computer on turn, if a computer is on turn. Nobody answers while they are
   * away, and the game waits (§12.4); `connected` asks again.
   */
  private async requestAiMove(setup: SetupState, game: GameState): Promise<void> {
    if (game.status !== 'in_progress') return;
    const active = activePlayer(game);
    if (active.control !== 'ai') return;
    await this.ports.broadcaster.sendTo(setup.gameMaster, {
      type: 'gm.requestAiMove',
      gameId: this.gameId,
      requestId: computerMoveRequestId(game),
      player: active.id,
    });
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

/**
 * The game list's row for a setup and, once started, its game; `null` once it
 * is off the list. [Q55, 36] A finished game stays on until it is deleted.
 */
export function listingOf(setup: SetupState, game: GameState | null): GameListing | null {
  if (setup.phase === 'cancelled' || setup.phase === 'expired') return null;
  const people = setup.seats.filter((seat) => seat.userId !== null);
  const finished = game !== null && game.status === 'finished';
  const active = game !== null && !finished ? activePlayer(game) : null;
  return {
    gameId: setup.gameId,
    name: setup.name,
    gameMaster: setup.gameMaster,
    gameMasterName: setup.gameMasterName,
    phase: finished ? 'finished' : setup.phase === 'started' ? 'in_progress' : 'setup',
    seatsTaken: people.length,
    seatsTotal: people.length + setup.seats.filter(isOpenSeat).length,
    createdAt: setup.createdAt,
    endsAt: setup.endsAt,
    members: people.map((seat) => seat.userId).filter((id): id is UserId => id !== null),
    turnOf: active !== null && active.control === 'human' ? (setup.seats.find((seat) => seat.playerId === active.id)?.userId ?? null) : null,
    result:
      game === null || !finished || game.ending === null
        ? null
        : {
            ending: game.ending,
            winners: game.players.filter((player) => game.winners.includes(player.id)).map((player) => player.name),
          },
  };
}

/** The seat `user` plays, which must be a person's seat the computer is not playing. */
function humanPlayerOf(setup: SetupState, game: GameState, user: UserId): PlayerId {
  const seat = setup.seats.find((candidate) => candidate.userId === user);
  if (seat === undefined) throw new SetupError('invalid_action', 'you hold no seat in this game');
  const player = game.players.find((candidate) => candidate.id === seat.playerId);
  if (player === undefined || player.control !== 'human') throw new SetupError('invalid_action', 'the computer plays your seat');
  return player.id;
}

/** [Q54, 35] A turn message names the turn it was for; one already over is refused, never played on the next. */
function requireTurn(game: GameState, turn: number): void {
  if (turn !== game.turn.number) throw new SetupError('turn_over', 'that turn has already been played');
}

function notFound(gameId: GameId): ServerMessage {
  return { type: 'error', code: 'game_not_found', message: `there is no game ${gameId}` };
}

function removed(): ServerMessage {
  return { type: 'error', code: 'game_removed', message: 'this game has ended and been removed' };
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
