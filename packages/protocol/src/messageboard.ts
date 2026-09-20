/**
 * The message board is **game state**, not a protocol concern.
 *
 * [SOURCE §12.3, chat] "The message board should be part of the game state and
 * as such persistent along with the rest of the game. There is no difference
 * between the message board state and other game state."
 *
 * So `BoardPost` is defined in `@adventure/core` alongside `GameState`, and is
 * re-exported here only so protocol consumers have one import site. Posts reach
 * clients inside `game.state` / `game.events` like any other state change;
 * there is no separate board message, store or retention policy.
 */
export type { BoardPost } from '@adventure/core';
