import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { goldExhaustedTermination, type RestRule } from '@adventure/sim';
import { computerDriver } from './aiPlaythrough.ts';
import { formatPlaythrough, playGame } from './playthrough.ts';
import { formatSelfPlayReport, runSelfPlayBatch } from './selfplay.ts';

/**
 * For these tests only. When a computer rests is the designer's to pick, so
 * the harness takes the rule as an argument and the tests bring their own.
 */
const restWhenStuck: RestRule = {
  name: 'test: rest when stuck',
  restsInstead: (_state, _player, _route, preview) => preview.reachableStepCount === 0,
};

/** A clock that ticks once per read, so a budget of N is about N iterations. */
function counter(): () => number {
  let now = 0;
  return () => now++;
}

const computer = (iterations: number) => ({
  thinkingMs: iterations,
  restRule: restWhenStuck,
  termination: goldExhaustedTermination(),
  now: counter(),
});

describe('a computer-against-computer game', () => {
  const run = playGame(
    { seed: 'adventure', diceSeed: 'dice-adventure', playerCount: 2, maxTurns: 2000 },
    DEFAULT_RULESET,
    computerDriver({ ...computer(4), ruleset: DEFAULT_RULESET, seed: 'adventure' }),
  );

  it('plays to §1’s win condition', () => {
    expect(run.endedBy).toBe('victory');
    expect(run.finalState.winners.length).toBeGreaterThan(0);
  });

  it('says for every turn where the computer was heading, or that it rested, and why', () => {
    const text = formatPlaythrough(run);
    const turns = text.split('\n\nturn ').slice(1);
    expect(turns).toHaveLength(run.turns.length);
    for (const turn of turns) {
      expect(turn).toMatch(/\n {2}plan {4}(heading for node \d+|already on node \d+|rests)/);
      expect(turn).toMatch(/\n {2}why {5}\d+ games played in its head/);
    }
  });

  it('only ever takes a turn for the seat whose turn it is', () => {
    run.turns.forEach((turn, index) => {
      expect(turn.seat).toBe((index % 2) + 1);
    });
  });
});

describe('runSelfPlayBatch', () => {
  it('reports each game, the machine it ran on, and the totals', () => {
    const report = runSelfPlayBatch({
      ruleset: DEFAULT_RULESET,
      seeds: ['blackmere'],
      playerCount: 2,
      maxTurns: 2000,
      computer: computer(2),
    });
    expect(report.games).toHaveLength(1);
    expect(report.games[0]?.endedBy).toBe('victory');
    const text = formatSelfPlayReport(report);
    expect(text).toContain('machine ');
    expect(text).toContain('1 of 1 games reached a winner');
  });
});
