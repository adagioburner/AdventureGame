import type { GameId, PlayerId } from '@adventure/core';

/**
 * [SOURCE §4] "A message board lets human players post messages visible to
 * everyone."
 *
 * [OPEN §12.3] Persistence and scope — per-game vs. cross-game, retention — are
 * not specified. Routed around, not decided: the post carries a `gameId`, so a
 * per-game board needs no change and a cross-game board only needs the store to
 * ignore that field. Retention lives entirely in the `MessageBoardStore` port
 * (`@adventure/session`), which has no default implementation, so no retention
 * behaviour is baked into the protocol or the client.
 *
 * "human players post" — the engine never posts on an AI player's behalf.
 */
export interface BoardPost {
  readonly id: string;
  readonly gameId: GameId;
  readonly author: PlayerId;
  readonly body: string;
  readonly postedAt: number;
}
