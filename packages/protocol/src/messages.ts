import type { ControlMode, GameEvent, GameId, GameState, NodeId, PlayerId, UserId } from '@adventure/core';
import type { BoardPost } from './messageboard.ts';
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
  | { readonly type: 'board.post'; readonly gameId: GameId; readonly body: string };

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
  | { readonly type: 'board.posts'; readonly gameId: GameId; readonly posts: readonly BoardPost[] }
  | { readonly type: 'error'; readonly message: string; readonly code: ProtocolErrorCode };

export type ProtocolErrorCode =
  | 'unauthenticated'
  | 'not_game_master'
  | 'not_your_turn'
  | 'invalid_action'
  | 'game_not_found'
  | 'game_full'
  /** Raised when a request needs a decision GDD.md has not made yet. */
  | 'unresolved_design_item';
