import type { GameId, PlayerId, UserId } from './ids.ts';

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
 *
 * [Q317, 8] Someone the game master let in to watch posts too: such a post
 * has no player for its author, and carries the watcher instead.
 */
export interface BoardPost {
  readonly id: string;
  readonly gameId: GameId;
  /** The player who posted; `null` for a watcher's post. */
  readonly author: PlayerId | null;
  /** [Q317, 8] The watcher who posted, by their username; absent on a player's post. */
  readonly watcher?: BoardWatcher;
  /** The words; empty once the post is deleted. */
  readonly body: string;
  readonly postedAt: number;
  /**
   * [Q85, 299] The game master deleted the post: it keeps its place, author
   * and time, and its words are gone. Absent on every post that was not.
   */
  readonly deleted?: true;
}

/** [Q317, 1 and 8] Someone watching a game, who goes by their username. */
export interface BoardWatcher {
  readonly userId: UserId;
  readonly name: string;
}
