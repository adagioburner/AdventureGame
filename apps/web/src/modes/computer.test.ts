import { describe, expect, it } from 'vitest';
import { mapFor } from '../page/seed.ts';
import { hotseatComputer } from './computer.ts';
import { HotseatGame, type HotseatSeat } from './hotseat.ts';

const map = mapFor('adventure');
const seats: readonly HotseatSeat[] = [
  { name: 'Ada', avatarId: 'player_avatars_01', control: 'ai', thinkingSeconds: 1 },
  { name: 'Bram', avatarId: 'player_avatars_02', control: 'ai', thinkingSeconds: 2 },
];

describe('the hot seat computer (Q41, Q42)', () => {
  it('thinks for its own seat’s time, then plays a legal move', async () => {
    const game = new HotseatGame({ map, seats, diceSeed: 'computer-test' });
    const computer = hotseatComputer(game);
    for (const seconds of [1, 2]) {
      const player = game.state.players[game.state.turn.activeSeat - 1]!;
      const started = performance.now();
      const action = await computer.chooseAction(game.state, player.id);
      const took = performance.now() - started;
      expect(took).toBeGreaterThanOrEqual(seconds * 1000);
      expect(took).toBeLessThan(seconds * 1000 + 500);
      expect(action.player).toBe(player.id);
      expect(() => game.play(action)).not.toThrow();
    }
    expect(game.turns.map((turn) => turn.seat)).toEqual([1, 2]);
  });

  it('stops thinking when cancelled, and never answers', async () => {
    const game = new HotseatGame({ map, seats, diceSeed: 'computer-cancel' });
    const cancel = { aborted: false };
    let answered = false;
    void hotseatComputer(game)
      .chooseAction(game.state, game.state.players[0]!.id, cancel)
      .then(() => {
        answered = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancel.aborted = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(answered).toBe(false);
  });
});
