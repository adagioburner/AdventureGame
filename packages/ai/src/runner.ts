import type { GameState, PlayerId, TurnAction } from '@adventure/core';

/**
 * The session layer's view of an AI player — deliberately tiny, and async.
 *
 * Async because a move costs `MCTS_TIME_BUDGET_PER_MOVE` (10 s) of CPU, which
 * must not run inside a request handler or on the UI thread. The session layer
 * depends only on this interface, so the same `GameSession` code works whether
 * the search runs in a Web Worker (hotseat, local play), in a worker thread
 * next to the server, or in a separate service reached over the network — which
 * matters, because where that CPU lives is the main constraint the hosting
 * decision (§12.1) has to satisfy.
 */
export interface AiPlayer {
  chooseAction(state: GameState, subject: PlayerId, cancel?: Cancellation): Promise<TurnAction>;
}

/**
 * Minimal cancellation token. Structurally satisfied by a DOM/Node
 * `AbortSignal`, so callers can pass one directly, but declaring it this way
 * keeps every engine package free of `lib.dom` and runnable unchanged on Node,
 * in a browser worker and on an edge runtime — which the hosting decision
 * (§12.1) should not be able to invalidate.
 */
export interface Cancellation {
  readonly aborted: boolean;
}
