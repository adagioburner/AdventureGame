import type {
  ControlMode,
  GameId,
  GameMap,
  GameState,
  NodeId,
  PlayerId,
  TurnAction,
  UserId,
} from '@adventure/core';
import type { GameSummary, SetupState } from './lobby.ts';
import type { GameRecord } from './records.ts';

/**
 * The client↔server contract.
 *
 * Deliberately transport-agnostic: these are plain data, with no WebSocket, no
 * HTTP verb and no Durable Object in sight. The transport is chosen by an
 * adapter in `apps/server`, which is what keeps the hosting decision (§12.1)
 * reversible.
 *
 * [SOURCE §2] There is no hidden information, so the server can send the whole
 * `GameState` to everyone and never has to compute a per-player view. The one
 * thing that is not shared is the server's die stream (§8) — future rolls are
 * not "information about the map".
 */

/* ----------------------------- client → server ---------------------------- */

export type ClientMessage =
  /* ---- the lobby socket ---- */
  /**
   * [Q48, 6] Creates a game in setup, with the sender as its game master in
   * seat 1. [Q51, 25 and 26] Turning "Play online" on sends the setup the page
   * already has, in `setup`; the game list's New game sends none, and the game
   * starts as a new game does on the hot seat screen, two seats both Human.
   */
  | { readonly type: 'lobby.create'; readonly name: string; readonly setup?: NewGameSetup }
  /* ---- a game's socket, before the start (§6.1, Q48) ---- */
  /** Ask to join with the name and figure to play as. Asking twice changes the request. */
  | { readonly type: 'setup.requestJoin'; readonly gameId: GameId; readonly name: string; readonly avatarId: string }
  /**
   * Change a request still waiting. Refused once the game master has
   * answered it, so an edit that crosses a "no" does not ask again.
   */
  | { readonly type: 'setup.updateRequest'; readonly gameId: GameId; readonly name: string; readonly avatarId: string }
  | { readonly type: 'setup.withdraw'; readonly gameId: GameId }
  /** A seated person other than the game master gives up their seat. */
  | { readonly type: 'setup.leave'; readonly gameId: GameId }
  /**
   * A person changes their own seat's name and figure, or the game master a
   * computer seat's ([Q48, 10 and 14]). `seatId` is `SetupSeat.id`.
   */
  | { readonly type: 'setup.updateSeat'; readonly gameId: GameId; readonly seatId: string; readonly name: string; readonly avatarId: string }
  // [SOURCE §3] GM-only setup actions. Authority is checked by the session layer.
  | { readonly type: 'setup.setPlayerCount'; readonly gameId: GameId; readonly count: number }
  | { readonly type: 'setup.respondToJoin'; readonly gameId: GameId; readonly userId: UserId; readonly accept: boolean }
  | { readonly type: 'setup.setSeed'; readonly gameId: GameId; readonly seed: string }
  /** [Q51, 27] The game's name, as the game list shows it. */
  | { readonly type: 'setup.rename'; readonly gameId: GameId; readonly name: string }
  /** [Q51, 22] Makes a seat Human (kept for someone who joins) or Computer. */
  | { readonly type: 'setup.setSeatControl'; readonly gameId: GameId; readonly seatId: string; readonly control: ControlMode }
  /** [Q51, 24] One computer seat's thinking time, whole seconds. */
  | { readonly type: 'setup.setThinkingTime'; readonly gameId: GameId; readonly seatId: string; readonly seconds: number }
  | { readonly type: 'setup.cancel'; readonly gameId: GameId }
  | { readonly type: 'setup.start'; readonly gameId: GameId }
  /**
   * [Q55, 43] "Game lasts" on the new game screen: 1, 3, 7 or 14 days from
   * creation (`LIFETIME_DAYS`), changeable until Start.
   */
  | { readonly type: 'setup.setLifetime'; readonly gameId: GameId; readonly days: number }
  /**
   * [SOURCE §4] Out-of-turn planning: a player may plan while others play, and
   * an unfinished path is saved and may still be changed. Sent whenever the
   * plan changes, by any player, at any time. The route is the one the page
   * drew with `routeVia`, excluding the player's own node; an empty path
   * clears it.
   * [SOURCE §intro, chat] In hotseat mode the client never sends this for a
   * player who is not the active one — there is no out-of-turn planning there.
   */
  | {
      readonly type: 'turn.plan';
      readonly gameId: GameId;
      readonly path: readonly NodeId[];
      readonly waypoint: NodeId | null;
    }
  /**
   * [SOURCE §4] "End Turn" commits the last-shown path. `turn` is the turn
   * number the page ended, so an End Turn sent twice (a reconnect, a second
   * device, [Q54, 35]) is played once: the second names a turn already over.
   */
  | {
      readonly type: 'turn.end';
      readonly gameId: GameId;
      readonly turn: number;
      readonly path: readonly NodeId[];
      readonly waypoint: NodeId | null;
    }
  /** [SOURCE §2] Rest instead of moving. `turn` as for `turn.end`. */
  | { readonly type: 'turn.rest'; readonly gameId: GameId; readonly turn: number }
  /**
   * [SOURCE §4] GM forces a slow player's planned move, or a rest if none.
   * `turn` is the turn the game master saw, so a Move on that crosses the
   * player's own End Turn is refused rather than played on the next turn.
   */
  | { readonly type: 'gm.forceTurn'; readonly gameId: GameId; readonly player: PlayerId; readonly turn: number }
  /** [Q55, 44] Adds a day to the game's lifetime, up to 14 days from creation. */
  | { readonly type: 'gm.extendLifetime'; readonly gameId: GameId }
  /** [Q55, 40] Ends a game in progress without a winner. */
  | { readonly type: 'gm.endGame'; readonly gameId: GameId }
  /** [SOURCE §4] GM switches any player between human and AI control at will. */
  | { readonly type: 'gm.setControl'; readonly gameId: GameId; readonly player: PlayerId; readonly control: ControlMode }
  /**
   * [SOURCE §4] A human may resign at any time; an AI takes over.
   * [Q56, 57] The computer plays the seat from then on, thinking for
   * `RESIGNED_THINKING_SECONDS`.
   */
  | { readonly type: 'player.resign'; readonly gameId: GameId }
  /**
   * [SOURCE §12.3, chat] The board is game state, so a post is an ordinary
   * state change: it comes back to everyone as a `game.played` record.
   * [Q56, 59] Anyone holding a seat may post, from Start until the game is
   * removed, up to `BOARD_POST_MAX` characters.
   */
  | { readonly type: 'board.post'; readonly gameId: GameId; readonly body: string }
  /* ---- game-master compute (§12.1) ---- */
  /**
   * [SOURCE §12.1, chat] "Map generation and player AI run on the game master's
   * machine." These two carry the results back.
   *
   * The GM's client generates the map from the seed and uploads it; the server
   * does not run the §2.1 pipeline. [SOURCE §12.1, chat] "Both strategies work.
   * Let[']s send the map over to all players, this is less error prone" — so the
   * finished `GameMap` travels, rather than each client regenerating from the
   * seed. Determinism still buys replay and debugging; it just is not used to
   * save bandwidth here.
   */
  | { readonly type: 'gm.mapGenerated'; readonly gameId: GameId; readonly map: GameMap }
  /** The GM's client answering a `gm.requestAiMove`, with the searched move. */
  | {
      readonly type: 'gm.aiMove';
      readonly gameId: GameId;
      readonly requestId: string;
      readonly player: PlayerId;
      readonly action: TurnAction;
    };

/**
 * The setup a game is created with when "Play online" is turned on
 * ([Q51, 25]). Seat 1 is the sender's: only its figure is used, and its name is
 * their username. Every other Human seat is kept for someone who asks to join;
 * a computer seat keeps its name, figure and thinking time.
 */
export interface NewGameSetup {
  readonly mapSeed: string;
  readonly seats: readonly NewGameSeat[];
}

export type NewGameSeat =
  | { readonly control: 'human'; readonly avatarId?: string }
  | { readonly control: 'ai'; readonly name: string; readonly avatarId: string; readonly thinkingSeconds: number };

/* ----------------------------- server → client ---------------------------- */

export type ServerMessage =
  /** The whole list, sent on connect and again whenever it changes. */
  | { readonly type: 'lobby.games'; readonly games: readonly GameSummary[] }
  /** The answer to `lobby.create`, to the creator only. */
  | { readonly type: 'lobby.created'; readonly gameId: GameId }
  | { readonly type: 'setup.state'; readonly setup: SetupState }
  /** [Q48, 11] To a declined user only. They may ask again. */
  | { readonly type: 'setup.declined'; readonly gameId: GameId }
  /** Full state, sent on join/reconnect. Cheap enough at this scale, and exact. */
  | { readonly type: 'game.state'; readonly state: GameState }
  /**
   * [Q54, 32] Everything played since the start, sent after `game.state` on
   * every connect, so a page that opens mid-game can show every turn in its
   * log, the ones played while its player was away included.
   */
  | { readonly type: 'game.history'; readonly gameId: GameId; readonly records: readonly GameRecord[] }
  /**
   * One change during play, to everyone. Clients apply it to the last full
   * state with `replayRecord`; the client's copy of `@adventure/core` performs
   * the same transition the server did, so a desync is a bug rather than a
   * design allowance. A `seq` that does not follow the last one means a
   * message was missed, and the page reloads the game.
   */
  | { readonly type: 'game.played'; readonly gameId: GameId; readonly record: GameRecord }
  /**
   * [Q54, 31] The people in the game who are away: no page of theirs has the
   * game open, or none has been heard from for a minute. Sent on connect and
   * whenever it changes.
   */
  | { readonly type: 'game.presence'; readonly gameId: GameId; readonly away: readonly UserId[] }
  /**
   * [SOURCE §12.1, chat] Sent only to the game master's client, asking it to run
   * the MCTS search for an AI-controlled seat and reply with `gm.aiMove`. The
   * server holds no AI of its own.
   *
   * [SOURCE §12.4, chat] If the game master is not connected, nobody answers
   * this and the game stalls — which is the specified behaviour, not a failure
   * mode to work around.
   */
  | {
      readonly type: 'gm.requestAiMove';
      readonly gameId: GameId;
      readonly requestId: string;
      readonly player: PlayerId;
    }
  /** Sent only to the game master's client, asking it to generate the map. */
  | { readonly type: 'gm.requestMapGeneration'; readonly gameId: GameId; readonly seed: string }
  | { readonly type: 'error'; readonly message: string; readonly code: ProtocolErrorCode };

export type ProtocolErrorCode =
  | 'unauthenticated'
  | 'not_game_master'
  | 'not_your_turn'
  /**
   * [Q54, 35; Q56, 55] The turn a message named is over: someone else acted
   * first (the game master's Move on, the player's own End turn, another of
   * their devices). The page already has the turn that was played.
   */
  | 'turn_over'
  | 'invalid_action'
  | 'game_not_found'
  /** [Q55, 37] The game ended or was cancelled more than 7 days ago and has been deleted. */
  | 'game_removed'
  | 'game_full'
  /**
   * [SOURCE §12.4, chat] "The game cannot proceed for a player that cannot
   * establish connection with the game state server. If the game master
   * disconnects there is no one to force the next turn so the game stalls as
   * well." With map generation and AI on the GM's machine (§12.1), a
   * disconnected GM also blocks every AI turn and map creation. Reported, not
   * worked around.
   */
  | 'game_master_unavailable'
  /** Raised when a request needs a decision GDD.md has not made yet. */
  | 'unresolved_design_item';

/** [Q56, 59] The longest post on a game's board, in characters. */
export const BOARD_POST_MAX = 500;

/** [Q56, 57] How long the computer thinks for a seat whose player resigned, in seconds. */
export const RESIGNED_THINKING_SECONDS = 10;
