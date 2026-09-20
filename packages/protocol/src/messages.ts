import type {
  ControlMode,
  GameEvent,
  GameId,
  GameMap,
  GameState,
  NodeId,
  PlayerId,
  TurnAction,
  UserId,
} from '@adventure/core';
import type { GameSummary, SetupState } from './lobby.ts';

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
  | { readonly type: 'lobby.list' }
  | { readonly type: 'lobby.create'; readonly name: string; readonly mode: 'online' | 'hotseat' }
  | { readonly type: 'lobby.requestJoin'; readonly gameId: GameId; readonly name: string; readonly avatarId: string }
  // [SOURCE §3] GM-only setup actions. Authority is checked by the session layer.
  | { readonly type: 'setup.setPlayerCount'; readonly gameId: GameId; readonly count: number }
  | { readonly type: 'setup.respondToJoin'; readonly gameId: GameId; readonly userId: UserId; readonly accept: boolean }
  | { readonly type: 'setup.addAiPlayer'; readonly gameId: GameId; readonly name: string; readonly avatarId: string }
  | { readonly type: 'setup.start'; readonly gameId: GameId }
  /**
   * [SOURCE §4] Out-of-turn planning: a player may plan while others play, and
   * an unfinished path is saved and may still be changed. Sent whenever the
   * plan changes, by any player, at any time.
   * [SOURCE §intro, chat] In hotseat mode the client never sends this for a
   * player who is not the active one — there is no out-of-turn planning there.
   */
  | {
      readonly type: 'turn.plan';
      readonly gameId: GameId;
      readonly destination: NodeId;
      readonly waypoint: NodeId | null;
    }
  /** [SOURCE §4] "End Turn" commits the last-shown path. */
  | { readonly type: 'turn.end'; readonly gameId: GameId }
  /** [SOURCE §2] Rest instead of moving. */
  | { readonly type: 'turn.rest'; readonly gameId: GameId }
  /** [SOURCE §4] GM forces a slow player's planned move, or a rest if none. */
  | { readonly type: 'gm.forceTurn'; readonly gameId: GameId; readonly player: PlayerId }
  /** [SOURCE §4] GM switches any player between human and AI control at will. */
  | { readonly type: 'gm.setControl'; readonly gameId: GameId; readonly player: PlayerId; readonly control: ControlMode }
  /** [SOURCE §4] A human may resign at any time; an AI takes over. */
  | { readonly type: 'player.resign'; readonly gameId: GameId }
  /**
   * [SOURCE §12.3, chat] The board is game state, so a post is an ordinary
   * state change; the reply arrives inside `game.events`, not a board-specific
   * message.
   */
  | { readonly type: 'board.post'; readonly gameId: GameId; readonly body: string }
  /* ---- game-master compute (§12.1) ---- */
  /**
   * [SOURCE §12.1, chat] "Map generation and player AI run on the game master's
   * machine." These two carry the results back.
   *
   * The GM's client generates the map from the seed and uploads it; the server
   * does not run the §2.1 pipeline. (Generation is deterministic in
   * `(seed, ruleset)`, so sending only the seed and having every client
   * regenerate would also work and cost far less bandwidth — but that moves
   * generation onto every machine, not just the GM's, so it is not assumed.
   * See OPEN_QUESTIONS Q15.)
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

/* ----------------------------- server → client ---------------------------- */

export type ServerMessage =
  | { readonly type: 'lobby.games'; readonly games: readonly GameSummary[] }
  | { readonly type: 'setup.state'; readonly setup: SetupState }
  /** Full state, sent on join/reconnect. Cheap enough at this scale, and exact. */
  | { readonly type: 'game.state'; readonly state: GameState }
  /**
   * Incremental updates during play. Clients apply these to the last full
   * state; the client's copy of `@adventure/core` performs the same transition
   * the server did, so a desync is a bug rather than a design allowance.
   */
  | { readonly type: 'game.events'; readonly gameId: GameId; readonly events: readonly GameEvent[] }
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
  | 'invalid_action'
  | 'game_not_found'
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
