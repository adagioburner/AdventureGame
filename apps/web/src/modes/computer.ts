import { startComputerMove, type AiPlayer, type Cancellation } from '@adventure/ai';
import type { GameConfig } from '@adventure/config';
import { createDiceSource, createRng, type GameState, type PlayerId, type TurnAction } from '@adventure/core';
import type { HotseatGame } from './hotseat.ts';

/** How long the computer thinks in each frame before handing the page back to draw it. */
export const SLICE_MS = 12;

/**
 * The computer's seats in a hot seat game (§9; Q41, Q42): `chooseComputerMove`
 * with each seat's own thinking time.
 *
 * It thinks on the page's own thread, a slice of about `SLICE_MS` a frame,
 * with the thread handed back after each one so the frame is drawn: the map
 * still pans and zooms and the thinking bar still fills. A Web Worker would
 * keep the thread entirely free, but the published game page cannot count on
 * being allowed to start one; slices work wherever the page does. The
 * thinking time is wall-clock time from the moment it starts, the page's own
 * drawing included.
 *
 * Its randomness and its die are its own, seeded from the game's die seed, so
 * the games it plays in its head never use up a real roll.
 */
export function hotseatComputer(game: HotseatGame): AiPlayer {
  return pageComputer(game.setup.map.ruleset.config, `computer-${game.setup.diceSeed}`, (state, subject) => {
    const seat = state.players.find((player) => player.id === subject)?.seat;
    return seat === undefined ? undefined : game.setup.seats[seat - 1]?.thinkingSeconds;
  });
}

/**
 * The computer thinking on this page, for as many seconds as `secondsFor`
 * gives the seat: hot seat's computer seats, and online the computer seats of
 * a game this page's player is the game master of (§12.1, plan phase 7 item
 * 8). `seed` seeds the games it plays in its head.
 */
export function pageComputer(
  config: GameConfig,
  seed: string,
  secondsFor: (state: GameState, subject: PlayerId) => number | undefined,
): AiPlayer {
  const rng = createRng(seed);
  const dice = createDiceSource(rng.fork('dice'), config);

  return {
    chooseAction(state: GameState, subject: PlayerId, cancel?: Cancellation): Promise<TurnAction> {
      const seconds = secondsFor(state, subject);
      if (seconds === undefined) return Promise.reject(new RangeError(`no seat for ${subject}`));

      const thinking = startComputerMove(state, subject, { config, thinkingMs: seconds * 1000, rng, dice, now: () => performance.now() });
      return new Promise((resolve, reject) => {
        const slice = (): void => {
          if (cancel?.aborted === true) return;
          try {
            if (thinking.step(SLICE_MS)) resolve(thinking.move().action);
            else handBack(slice);
          } catch (error) {
            reject(error);
          }
        };
        handBack(slice);
      });
    },
  };
}

/**
 * Run `next` once the page has drawn its next frame. Waiting on a message
 * alone is not enough: a browser may run message after message and put the
 * frame off, which is what a first try did. So the wait is for the frame's
 * callback, and then a message, which runs once that frame has been painted.
 * A hidden page draws no frames, and there (and outside a browser) it is the
 * message alone. A message rather than `setTimeout(0)`, which browsers hold
 * back by 4 ms once it nests.
 */
function handBack(next: () => void): void {
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  if (visible) requestAnimationFrame(() => afterMessage(next));
  else afterMessage(next);
}

function afterMessage(next: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    next();
  };
  channel.port2.postMessage(null);
}
