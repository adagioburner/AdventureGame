import type { GameId, PlayerId } from './ids.ts';

/**
 * [SOURCE §4] "A message board lets human players post messages visible to
 * everyone."
 *
 * [SOURCE §12.3, chat] "The message board should be part of the game state and
 * as such persistent along with the rest of the game. There is no difference
 * between the message board state and other game state."
 *
 * That settles §12.3 and simplifies three things at once:
 *
 *  - `BoardPost` lives here, in `@adventure/core`, not in the protocol package —
 *    it is game state, so it sits with the rest of it;
 *  - there is no `MessageBoardStore` port and no retention policy, because the
 *    board is persisted by whatever persists the game;
 *  - posting is a `GameAction` like any other, so it goes through
 *    `applyAction`, the single writer of `GameState`.
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
