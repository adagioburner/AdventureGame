import type { AiPlayer } from '@adventure/ai';
import type { GameMap, GameState, PlayerState, TurnAction } from '@adventure/core';
import type { PlayerId } from '@adventure/core';
import { hotseatComputer } from './computer.ts';
import { HOTSEAT_MODE, type HotseatGame, type PlayedTurn, type UiModeConfig } from './hotseat.ts';

/** One change to the game as the play screen shows it: a turn, or something else (a saved route, a post). */
export interface PlayedChange {
  readonly before: GameState;
  readonly after: GameState;
  /** `null` for a change that is not a turn: nothing walks, and the log has no entry. */
  readonly turn: PlayedTurn | null;
}

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
  /** A computer seat's thinking time in seconds; `null` for a person's seat. */
  thinkingSecondsOf(player: PlayerState): number | null;
  /**
   * Plays the local player's End Turn or Rest. Throws if the rules refuse it.
   * The turn comes back through `subscribe`, at once or once the server has played it.
   */
  commit(action: TurnAction): void;
  /** Hears every change from now on, in order. */
  subscribe(listener: (change: PlayedChange) => void): () => void;
}

/** A game on this device (§7.2): every turn is played here, at once, with the local die. */
export function hotseatPlay(game: HotseatGame): PlaySource {
  const listeners = new Set<(change: PlayedChange) => void>();
  const computer = hotseatComputer(game);
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
    history: [],
    computer,
    thinksFor: (player) => player.control === 'ai',
    thinkingSecondsOf: (player) => (player.control === 'ai' ? (game.setup.seats[player.seat - 1]?.thinkingSeconds ?? 0) : null),
    commit(action) {
      const before = game.state;
      const turn = game.play(action);
      for (const listener of listeners) listener({ before, after: turn.after, turn });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
