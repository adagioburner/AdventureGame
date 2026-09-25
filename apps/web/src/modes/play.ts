import type { AiPlayer } from '@adventure/ai';
import type { GameMap, GameState, PlayerId, PlayerState, TurnAction, UserId } from '@adventure/core';
import { computerMoveRequestId, type ClientMessage, type GameRecord, type SetupState } from '@adventure/protocol';
import { hotseatComputer, pageComputer } from './computer.ts';
import { HOTSEAT_MODE, type HotseatGame, type PlayedTurn, type UiModeConfig } from './hotseat.ts';
import { ONLINE_MODE, type AppliedRecord, type OnlineGame } from './online.ts';

/** One change to the game as the play screen shows it: a turn, or something else (a saved route, the end). */
export interface PlayedChange {
  readonly before: GameState;
  readonly after: GameState;
  /** `null` for a change that is not a turn: nothing walks, and the log has no entry. */
  readonly turn: PlayedTurn | null;
}

/** What the play screen hears from its game, in order: a change, or a turn it committed being refused. */
export type PlayUpdate =
  /**
   * `shown` says how: `'played'` plays a turn out (the walk, the die), and
   * `'caught_up'` only shows where it left everyone, for turns missed while
   * the connection was down ([Q54, 32]: "without replaying walks").
   */
  | { readonly kind: 'change'; readonly change: PlayedChange; readonly shown: 'played' | 'caught_up' }
  /**
   * What this page sent was not played: the server refused it and says why,
   * or, with `reason` null, it was lost with a dropped connection.
   */
  | { readonly kind: 'refused'; readonly reason: string | null };

/**
 * What the play screen plays: a game on this device (§7.2), or a stored game
 * the server plays (§7.1). The screen draws, animates and logs; this decides
 * what a committed turn does and tells the screen of every change, in order.
 */
export interface PlaySource {
  readonly mode: UiModeConfig;
  readonly map: GameMap;
  /** The game as it stands, ahead of the screen while a turn plays out. */
  readonly state: GameState;
  /** The players this page plans for: every person's seat on one device, one's own online. */
  readonly localPlayers: ReadonlySet<PlayerId>;
  /** The dice seed the turn log names, or `null` when there is none to show. */
  readonly diceSeed: string | null;
  /** Changes already played when the screen opened, oldest first: the log starts with their turns. */
  readonly history: readonly PlayedChange[];
  /** The computer this page thinks with, for the seats `thinksFor` names; `null` if it thinks for none. */
  readonly computer: AiPlayer | null;
  /** Whether this page thinks for `player`'s moves. */
  thinksFor(player: PlayerState): boolean;
  /** A computer seat's thinking time in seconds; `null` for a person's seat. */
  thinkingSecondsOf(player: PlayerState): number | null;
  /**
   * Plays End Turn or Rest for a local player, or a computer's move this page
   * thought of. Throws if it cannot be sent or the rules refuse it. The turn
   * comes back through `subscribe`: at once on one device, online once the
   * server has played it, or a refusal if the server would not.
   */
  commit(action: TurnAction): void;
  /** Hears every update from now on, in order. */
  subscribe(listener: (update: PlayUpdate) => void): () => void;
}

/** A game on this device (§7.2): every turn is played here, at once, with the local die. */
export function hotseatPlay(game: HotseatGame): PlaySource {
  const listeners = new Set<(update: PlayUpdate) => void>();
  const computer = hotseatComputer(game);
  return {
    mode: HOTSEAT_MODE,
    map: game.setup.map,
    get state() {
      return game.state;
    },
    // A computer seat is not this screen's to plan for: its saved route
    // is never brought back as a preview, and its figure cannot be picked up.
    localPlayers: new Set(game.state.players.filter((player) => player.control === 'human').map((player) => player.id)),
    diceSeed: game.setup.diceSeed,
    history: [],
    computer,
    thinksFor: (player) => player.control === 'ai',
    thinkingSecondsOf: (player) => (player.control === 'ai' ? (game.setup.seats[player.seat - 1]?.thinkingSeconds ?? 0) : null),
    commit(action) {
      const before = game.state;
      const turn = game.play(action);
      for (const listener of listeners) listener({ kind: 'change', change: { before, after: turn.after, turn }, shown: 'played' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A stored game on the play screen, fed by the page's socket. */
export interface OnlinePlay extends PlaySource {
  /** The last record applied, so a reconnect applies only what it missed. */
  readonly lastSeq: number;
  /**
   * A record the server sent, as it was played, or `caught_up` for one missed
   * while the connection was down. Throws `MissedRecords` if one before it is missing.
   */
  receive(record: GameRecord, shown: 'played' | 'caught_up'): void;
  /**
   * The server refused something this page sent; `null` once a reconnect has
   * brought the game up to date, for anything sent that never arrived.
   */
  refused(reason: string | null): void;
}

export interface OnlinePlayOptions {
  /** The game's setup as Start left it: its seats, their holders and thinking times. */
  readonly setup: SetupState;
  readonly me: UserId;
  /** The game as the page opened it (`OnlineGame.open`). */
  readonly game: OnlineGame;
  readonly applied: readonly AppliedRecord[];
  /** Sends on the game's socket; `false` if it is not open. */
  send(message: ClientMessage): boolean;
}

/**
 * A stored game (§7.1, §12.1): the server plays every turn, with its own dice
 * (§8), and this page sends what its player commits and shows what comes
 * back, the same way for its own turns and everyone else's.
 *
 * The game master's page also thinks for the computer seats (§12.1, plan
 * phase 7 item 8), each for its seat's thinking time, and sends the move.
 */
export function onlinePlay(options: OnlinePlayOptions): OnlinePlay {
  const { setup, me, game, send } = options;
  const listeners = new Set<(update: PlayUpdate) => void>();
  const tell = (update: PlayUpdate): void => {
    for (const listener of listeners) listener(update);
  };
  const seatOf = (player: PlayerId) => setup.seats.find((seat) => seat.playerId === player);
  const isGameMaster = setup.gameMaster === me;
  const map = game.state.map;
  const computer = isGameMaster
    ? pageComputer(map.ruleset.config, `computer-${setup.gameId}`, (_state, subject) => seatOf(subject)?.thinkingSeconds)
    : null;
  const deliver = (message: ClientMessage): void => {
    if (!send(message)) throw new Error('The connection to the server dropped. Try again once it is back.');
  };

  return {
    mode: ONLINE_MODE,
    map,
    get state() {
      return game.state;
    },
    get lastSeq() {
      return game.lastSeq;
    },
    localPlayers: new Set(setup.seats.filter((seat) => seat.control === 'human' && seat.userId === me).map((seat) => seat.playerId)),
    diceSeed: null,
    history: options.applied,
    computer,
    thinksFor: (player) => isGameMaster && player.control === 'ai',
    thinkingSecondsOf: (player) => (player.control === 'ai' ? (seatOf(player.id)?.thinkingSeconds ?? 0) : null),
    commit(action) {
      const state = game.state;
      const player = state.players.find((candidate) => candidate.id === action.player);
      if (player?.control === 'ai') {
        deliver({ type: 'gm.aiMove', gameId: setup.gameId, requestId: computerMoveRequestId(state), player: player.id, action });
        return;
      }
      if (action.kind === 'rest') {
        deliver({ type: 'turn.rest', gameId: setup.gameId, turn: state.turn.number });
        return;
      }
      if (action.kind !== 'move') throw new Error('Only a move or a rest can end a turn.');
      deliver({
        type: 'turn.end',
        gameId: setup.gameId,
        turn: state.turn.number,
        path: action.path,
        waypoint: action.waypoint ?? null,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive(record, shown) {
      const { before, after, turn } = game.apply(record);
      tell({ kind: 'change', change: { before, after, turn }, shown });
    },
    refused(reason) {
      tell({ kind: 'refused', reason });
    },
  };
}
