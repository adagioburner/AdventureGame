import type { GameEvent, GameState, PlayerId } from '@adventure/core';
import type { BoardPost, ClientMessage, ServerMessage } from '@adventure/protocol';

/**
 * The client's copy of the game.
 *
 * [SOURCE §2] No hidden information, so this is the *same* `GameState` the
 * server holds — there is no per-player projection, no fog, and no separate
 * client model to keep in sync. Events are applied with the same
 * `@adventure/core` transition the server ran, which is why the path a player
 * previews and the move the server commits cannot disagree.
 */
export interface ClientGameStore {
  readonly state: GameState | null;
  readonly localPlayer: PlayerId | null;
  readonly board: readonly BoardPost[];
  applyFullState(state: GameState): void;
  applyEvents(events: readonly GameEvent[]): void;
  subscribe(listener: () => void): () => void;
}

/**
 * The network seam. One interface, so the transport can be a WebSocket, a
 * Durable Object socket, long-polling or an in-memory loopback for hotseat and
 * tests — without the UI knowing. [OPEN §12.1] keeps this deliberately thin.
 */
export interface Transport {
  send(message: ClientMessage): void;
  onMessage(handler: (message: ServerMessage) => void): () => void;
  readonly connected: boolean;
}
