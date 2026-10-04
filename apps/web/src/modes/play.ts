import type { AiPlayer } from '@adventure/ai';
import type { BuyAction, GameMap, GameState, NodeId, PlayerId, PlayerState, TurnAction, UserId } from '@adventure/core';
import { computerMoveRequestId, type ClientMessage, type GameRecord, type ProtocolErrorCode, type SetupState } from '@adventure/protocol';
import { hotseatComputer, pageComputer } from './computer.ts';
import { HOTSEAT_MODE, type HotseatGame, type PlayedTurn, type Purchase, type UiModeConfig } from './hotseat.ts';
import { ONLINE_MODE, type AppliedRecord, type OnlineGame } from './online.ts';

/** One change to the game as the play screen shows it: a turn, or something else (a saved route, the end). */
export interface PlayedChange {
  readonly before: GameState;
  readonly after: GameState;
  /** `null` for a change that is not a turn: nothing walks, and the log has no entry. */
  readonly turn: PlayedTurn | null;
  /**
   * [Q190] A purchase, which is not a turn: the cards show it at once, and the
   * log gives it a line in its turn's entry, or an entry of its own if it ends
   * the game (756).
   */
  readonly purchase?: Purchase | null;
  /** [Q56, 54] The game master moved the player on: their saved route, or a rest. */
  readonly movedOn?: boolean;
  /** [Q85, 296] The game master resigned the player this page plays for. */
  readonly resignedYou?: boolean;
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
  /**
   * [Q56, 53] Online, saves the route a local player has drawn, as they draw
   * it; an empty path clears it. `false` if it could not be sent. `null` on
   * one device, where a route is kept only by the turn that walks it.
   */
  readonly savePlan: ((player: PlayerId, path: readonly NodeId[], waypoint: NodeId | null) => boolean) | null;
  /**
   * [Q56, 54] The game master's Move on for a person on turn: their saved
   * route, or a rest. `null` on every page but the game master's online.
   */
  readonly moveOn: ((player: PlayerState) => void) | null;
  /**
   * [Q85, 294] The game master resigns a person: the computer plays their seat
   * from then on. `null` on every page but the game master's online.
   */
  readonly resignPlayer: ((player: PlayerState) => void) | null;
  /** A computer seat's thinking time in seconds; `null` for a person's seat. */
  thinkingSecondsOf(player: PlayerState): number | null;
  /**
   * Plays End Turn or Rest for a local player, or a computer's move this page
   * thought of. Throws if it cannot be sent or the rules refuse it, except
   * online for a computer's move, which waits for the connection instead. The
   * turn comes back through `subscribe`: at once on one device, online once
   * the server has played it, or a refusal if the server would not.
   *
   * [Q190, 761] `buy` is what a computer bought before its move, played first.
   */
  commit(action: TurnAction, buy?: BuyAction | null): void;
  /**
   * [Q190] Done in the buy panel (768), or a computer's purchase that ends the
   * game (756). Throws as `commit` does; comes back through `subscribe` as a
   * change with a `purchase`, at once on one device, online once played.
   */
  buy(action: BuyAction): void;
  /** Hears every update from now on, in order. */
  subscribe(listener: (update: PlayUpdate) => void): () => void;
}

/** A game on this device (§7.2): every turn is played here, at once, with the local die. */
export function hotseatPlay(game: HotseatGame): PlaySource {
  const listeners = new Set<(update: PlayUpdate) => void>();
  const computer = hotseatComputer(game);
  const purchase = (action: BuyAction): void => {
    const before = game.state;
    const bought = game.buy(action);
    for (const listener of listeners) listener({ kind: 'change', change: { before, after: bought.after, turn: null, purchase: bought }, shown: 'played' });
  };
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
    // A game brought back after a reload ([Q56, 66]) opens with its turns in the log.
    history: hotseatHistory(game),
    computer,
    savePlan: null,
    moveOn: null,
    resignPlayer: null,
    thinksFor: (player) => player.control === 'ai',
    thinkingSecondsOf: (player) => (player.control === 'ai' ? (game.setup.seats[player.seat - 1]?.thinkingSeconds ?? 0) : null),
    commit(action, buy) {
      if (buy !== undefined && buy !== null) purchase(buy);
      const before = game.state;
      const turn = game.play(action);
      for (const listener of listeners) listener({ kind: 'change', change: { before, after: turn.after, turn }, shown: 'played' });
    },
    buy: purchase,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The changes a hot seat game reloaded has played: its turns, and the purchase that ended it, if one did. */
function hotseatHistory(game: HotseatGame): PlayedChange[] {
  const turns: PlayedChange[] = game.turns.map((turn, index) => ({ before: game.turns[index - 1]?.after ?? game.opening, after: turn.after, turn }));
  const ending = game.endingPurchase;
  if (ending === null) return turns;
  return [...turns, { before: game.turns.at(-1)?.after ?? game.opening, after: ending.after, turn: null, purchase: ending }];
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
  /** The server refused something this page sent, saying why in `reason` with `code`. */
  refused(reason: string | null, code?: ProtocolErrorCode): void;
  /**
   * A reconnect has brought the game up to date ([Q54, 32]). A computer's
   * move this page thought of goes again if its turn is still waiting;
   * otherwise anything sent that never arrived is refused with no reason.
   */
  reconnected(): void;
  /** The game's setup changed: a resigned seat's thinking time, the end time. */
  setSetup(setup: SetupState): void;
}

export interface OnlinePlayOptions {
  /** The game's setup: its seats, their holders and thinking times. */
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
  const { me, game, send } = options;
  let setup = options.setup;
  const gameId = setup.gameId;
  const listeners = new Set<(update: PlayUpdate) => void>();
  const tell = (update: PlayUpdate): void => {
    for (const listener of listeners) listener(update);
  };
  const seatOf = (player: PlayerId) => setup.seats.find((seat) => seat.playerId === player);
  const isGameMaster = setup.gameMaster === me;
  const map = game.state.map;
  const computer = isGameMaster
    ? pageComputer(game.state, `computer-${gameId}`, (_state, subject) => seatOf(subject)?.thinkingSeconds)
    : null;
  const deliver = (message: ClientMessage): void => {
    if (!send(message)) throw new Error('The connection to the server dropped. Try again once it is back.');
  };
  // The seats this page plans for: its player's, while a person plays them.
  // One set, kept current, since the move controller holds on to it; a seat
  // leaves it when its player resigns ([Q56, 57]).
  const localPlayers = new Set<PlayerId>();
  const refreshLocal = (): void => {
    localPlayers.clear();
    for (const seat of setup.seats) {
      const player = game.state.players.find((candidate) => candidate.id === seat.playerId);
      if (seat.userId === me && player?.control === 'human') localPlayers.add(seat.playerId);
    }
  };
  refreshLocal();
  // [Q56, 55] The game master's Move on still waiting for its answer.
  let movingOn: { readonly player: PlayerState; readonly turn: number } | null = null;
  // The computer's move this page sent last, until its turn has been played.
  // One that could not be sent, or was lost with a connection that had died
  // unnoticed, goes again once the connection is back: without it the
  // computer's turn would wait for good.
  let computerMove: Extract<ClientMessage, { type: 'gm.aiMove' }> | null = null;
  // [Q190] The turn of the purchase this page sent last, until it is played or refused.
  let buying: number | null = null;

  const changeOf = ({ record, before, after, turn, purchase }: AppliedRecord): PlayedChange => ({
    before,
    after,
    turn,
    purchase,
    movedOn: record.action.kind === 'force_turn',
    resignedYou: record.action.kind === 'resign' && record.by !== me && seatOf(record.action.player)?.userId === me,
  });

  return {
    mode: ONLINE_MODE,
    map,
    get state() {
      return game.state;
    },
    get lastSeq() {
      return game.lastSeq;
    },
    localPlayers,
    diceSeed: null,
    history: options.applied.map(changeOf),
    computer,
    thinksFor: (player) => isGameMaster && player.control === 'ai',
    thinkingSecondsOf: (player) => (player.control === 'ai' ? (seatOf(player.id)?.thinkingSeconds ?? 0) : null),
    savePlan(player, path, waypoint) {
      if (!localPlayers.has(player)) return false;
      // A route that cannot be saved now is sent again with the next change
      // once the connection is back, or goes with End turn.
      return send({ type: 'turn.plan', gameId, path, waypoint: path.length === 0 ? null : waypoint });
    },
    moveOn: isGameMaster
      ? (player) => {
          const turn = game.state.turn.number;
          deliver({ type: 'gm.forceTurn', gameId, player: player.id, turn });
          movingOn = { player, turn };
        }
      : null,
    resignPlayer: isGameMaster ? (player) => deliver({ type: 'gm.resignPlayer', gameId, player: player.id }) : null,
    commit(action, buy) {
      const state = game.state;
      const player = state.players.find((candidate) => candidate.id === action.player);
      if (player?.control === 'ai') {
        computerMove = {
          type: 'gm.aiMove',
          gameId,
          requestId: computerMoveRequestId(state),
          player: player.id,
          ...(buy === undefined || buy === null ? {} : { buy }),
          action,
        };
        send(computerMove);
        return;
      }
      // [490] End turn's rest that keeps its route goes as the End turn it
      // was: the server rests on that route the same way (`endTurnActionFor`).
      if (action.kind === 'rest' && action.plan !== undefined) {
        deliver({ type: 'turn.end', gameId, turn: state.turn.number, path: action.plan.path, waypoint: action.plan.waypoint });
        return;
      }
      if (action.kind === 'rest') {
        deliver({ type: 'turn.rest', gameId, turn: state.turn.number });
        return;
      }
      if (action.kind !== 'move') throw new Error('Only a move or a rest can end a turn.');
      deliver({ type: 'turn.end', gameId, turn: state.turn.number, path: action.path, waypoint: action.waypoint ?? null });
    },
    buy(action) {
      const state = game.state;
      const player = state.players.find((candidate) => candidate.id === action.player);
      if (player?.control === 'ai') {
        // [756] A computer's purchase that ends the game, with no move after it.
        computerMove = { type: 'gm.aiMove', gameId, requestId: computerMoveRequestId(state), player: player.id, buy: action, action: null };
        send(computerMove);
        return;
      }
      deliver({ type: 'turn.buy', gameId, turn: state.turn.number, skills: action.skills });
      buying = state.turn.number;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    receive(record, shown) {
      const applied = game.apply(record);
      if (record.action.kind === 'force_turn' && movingOn !== null && movingOn.turn === applied.before.turn.number) movingOn = null;
      if (computerMove !== null && computerMove.requestId !== computerMoveRequestId(game.state)) computerMove = null;
      if (record.action.kind === 'buy' && record.by === me) buying = null;
      if (record.action.kind === 'resign') refreshLocal();
      tell({ kind: 'change', change: changeOf(applied), shown });
    },
    refused(reason, code) {
      // [Q190] Done in the buy panel crossed the end of the turn: nothing was bought.
      if (code === 'turn_over' && buying !== null) {
        buying = null;
        tell({ kind: 'refused', reason: 'Your turn ended before the purchase arrived, so nothing was bought.' });
        return;
      }
      buying = null;
      if (code === 'turn_over') {
        // [Q56, 55] Someone acted on this turn first, and the page has the
        // turn that was played. The game master is told who; a player whose
        // End turn crossed the game master's Move on hears of it from that.
        const crossed = movingOn;
        movingOn = null;
        tell({ kind: 'refused', reason: crossed === null ? null : `${crossed.player.name} ended the turn first.` });
        return;
      }
      tell({ kind: 'refused', reason });
    },
    reconnected() {
      buying = null;
      const waiting = computerMove;
      if (waiting !== null && game.state.status === 'in_progress' && waiting.requestId === computerMoveRequestId(game.state)) {
        send(waiting);
        return;
      }
      computerMove = null;
      tell({ kind: 'refused', reason: null });
    },
    setSetup(next) {
      setup = next;
      refreshLocal();
    },
  };
}
