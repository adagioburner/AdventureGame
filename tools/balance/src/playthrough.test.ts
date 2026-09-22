import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { previewPath, totalGoldUnits } from '@adventure/core';
import { formatPlaythrough, playGame } from './playthrough.ts';

/**
 * Phase 2's end-to-end check: a whole game, on a real generated map, played
 * exclusively through `applyAction`.
 *
 * It lives in the harness rather than in `@adventure/core` because it needs a
 * generated map, and `@adventure/mapgen` depends on `@adventure/core` and not
 * the other way round. The rules themselves are tested against hand-built maps
 * beside the modules they live in; this is the test that says they compose into
 * a game that ends.
 */
describe('a full game', () => {
  const run = playGame(
    { seed: 'adventure', diceSeed: 'dice-adventure', playerCount: 2, maxTurns: 2000 },
    DEFAULT_RULESET,
  );

  it('reaches §1’s win condition', () => {
    expect(run.endedBy).toBe('victory');
    expect(run.finalState.status).toBe('finished');
    expect(run.finalState.winners).toHaveLength(1);
  });

  it('leaves the winner holding the most gold', () => {
    const winner = run.finalState.players.find((player) => run.finalState.winners.includes(player.id));
    const best = Math.max(...run.finalState.players.map((player) => player.stats.gold));
    expect(winner?.stats.gold).toBe(best);
  });

  it('never creates or destroys gold', () => {
    const held = run.finalState.players.reduce((sum, player) => sum + player.stats.gold, 0);
    const left = run.map.pois.reduce(
      (sum, poi, index) =>
        sum +
        (poi.reward.kind === 'gold' && run.finalState.poiRuntime[index]?.claimedBy === null ? poi.reward.units : 0),
      0,
    );
    expect(held + left).toBe(totalGoldUnits(run.map));
  });

  it('shares the one map object across every turn of the game', () => {
    // The state split exists so cloning a state does not clone the world
    // (§2.1's map is immutable); this is that promise, end to end.
    expect(run.finalState.map).toBe(run.map);
  });

  it('shows, for every step, the same accounting the engine committed', () => {
    // The transcript prints each step from `previewPath`, so it is only worth
    // reading if that agrees with what `resolveMovement` actually did — on
    // every move of a real game, not just on a hand-built example.
    for (const turn of run.turns) {
      for (const event of turn.events) {
        if (event.type !== 'moved') continue;
        const { resolution } = event;
        const preview = previewPath(
          run.map.graph,
          resolution.from,
          resolution.walked,
          turn.allowanceBefore,
          turn.statsBefore.stamina,
          DEFAULT_RULESET.config,
        );
        expect(preview.reachableStepCount).toBe(resolution.walked.length);
        expect(preview.totalStaminaCost).toBe(resolution.staminaSpent);
      }
    }
  });

  it('adds up: every turn\u2019s stamina is last turn\u2019s, less what moving cost, plus rest and rewards', () => {
    // The check a reader of the transcript would do by hand, done for all of it.
    for (const turn of run.turns) {
      let expected = turn.statsBefore.stamina;
      for (const event of turn.events) {
        if (event.type === 'moved') expected -= event.resolution.staminaSpent;
        if (event.type === 'rested') expected += event.staminaGained;
        if (event.type === 'interacted' && event.resolution.claimed && event.resolution.reward?.kind === 'stamina') {
          expected += event.resolution.reward.units;
        }
      }
      expect(turn.standings[turn.seat - 1]?.stats.stamina).toBe(expected);
    }
  });

  it('prints, as each turn’s plan, the route the move actually took', () => {
    // The "plan" line is recorded by the driver, not the engine, so check it
    // against what the engine walked: walked then remainder is the whole route.
    for (const turn of run.turns) {
      for (const event of turn.events) {
        if (event.type !== 'moved') continue;
        const { walked, remainder } = event.resolution;
        expect([...walked, ...remainder]).toEqual(turn.heading?.route);
      }
    }
  });

  it('matches the committed transcript', async () => {
    await expect(formatPlaythrough(run)).toMatchFileSnapshot('../../../golden/games/adventure-2p.txt');
  }, 30000);
});

describe('games on other seeds', () => {
  // Three more maps, so the engine is not shown terminating on one lucky
  // layout. Kept small: each one generates a map (§2.1) before it plays.
  for (const seed of ['blackmere', 'ravenmoor', 'thornfell']) {
    it(`terminates with a winner on seed "${seed}"`, () => {
      const run = playGame({ seed, diceSeed: `dice-${seed}`, playerCount: 2, maxTurns: 2000 }, DEFAULT_RULESET);
      expect(run.endedBy).toBe('victory');
      expect(run.finalState.winners.length).toBeGreaterThan(0);
      // Turn numbers are 1-based and advance by exactly one per turn played.
      expect(run.turns.map((turn) => turn.number)).toEqual(run.turns.map((_unused, index) => index + 1));
    }, 30000);
  }
});
