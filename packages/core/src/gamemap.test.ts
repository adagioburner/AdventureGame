import { describe, expect, it } from 'vitest';
import type { StartConfig } from '@adventure/config';
import { chooseStartingNode, spaceRemoteness, startingNodeFor, stepsFromForestAndMountains, type GameMap } from './gamemap.ts';
import { createRng } from './rng.ts';
import { fixtureMap, n } from './rules/scenario.fixture.ts';

/** `map` with the start rule set to `start`, or with none, as a game kept from before has. */
function withStart(map: GameMap, start: StartConfig | undefined): GameMap {
  const { start: _start, ...config } = map.ruleset.config;
  return { ...map, ruleset: { ...map.ruleset, config: start === undefined ? config : { ...config, start } } };
}

const ONE_STEP: StartConfig = { NEARBY_STEPS: 1, MAX_REMOTENESS: 0.1 };

describe('how deep a space is in the plains (Q227, 878)', () => {
  it('counts road steps to the nearest forest or mountain space, whatever the terrain', () => {
    const map = fixtureMap({ terrains: ['mountain', 'plains', 'plains', 'forest'], edges: [[0, 1], [1, 2], [2, 3]] });
    expect(stepsFromForestAndMountains(map.graph)).toEqual([0, 1, 1, 0]);
  });
});

describe("a space's remoteness (Q227, 876)", () => {
  it('averages the sites of every terrain within that many road steps, and no farther', () => {
    const map = fixtureMap({
      terrains: ['plains', 'plains', 'plains', 'forest', 'forest', 'forest', 'forest'],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
      pois: [
        { node: 1, kind: 'plains_move', units: 1, guard: null, remoteness: 0 },
        { node: 5, kind: 'mountain_move', units: 1, guard: null, remoteness: 0.4 },
        { node: 6, kind: 'gold', units: 1, guard: null, remoteness: 1 },
      ],
    });
    expect(spaceRemoteness(map, n(0), 5)).toBeCloseTo(0.2);
    expect(spaceRemoteness(map, n(0), 6)).toBeCloseTo(1.4 / 3);
    expect(spaceRemoteness(map, n(3), 1)).toBeNull();
  });
});

describe('where the figures start (Q227)', () => {
  // forest 0, then plains 1 to 7 along one road: space n is n steps deep.
  const line = fixtureMap({
    terrains: ['forest', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
    pois: [
      { node: 3, kind: 'plains_move', units: 1, guard: null, remoteness: 0.05 },
      { node: 7, kind: 'forest_move', units: 3, guard: null, remoteness: 0.5 },
    ],
  });

  it('is the deepest plains space whose sites nearby average below the limit', () => {
    // 2 and 4 have only the 0.05 site next to them; 6 has the 0.5 one; 1 and 5 have none.
    expect(startingNodeFor(withStart(line, ONE_STEP))).toBe(n(4));
  });

  it('takes the least remote of equally deep spaces (873)', () => {
    // forest 0, plains 1 and 2, then 2 forks to spaces 3 and 4, both 3 steps deep.
    const fork = fixtureMap({
      terrains: ['forest', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
      edges: [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6]],
      pois: [
        { node: 5, kind: 'plains_move', units: 1, guard: null, remoteness: 0.08 },
        { node: 6, kind: 'magic', units: 1, guard: null, remoteness: 0.02 },
      ],
    });
    expect(startingNodeFor(withStart(fork, ONE_STEP))).toBe(n(4));
  });

  it('is the least remote space when none is below the limit (874)', () => {
    const remote = fixtureMap({
      terrains: ['forest', 'plains', 'plains', 'plains', 'plains'],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
      pois: [
        { node: 2, kind: 'plains_move', units: 1, guard: null, remoteness: 0.15 },
        { node: 4, kind: 'forest_move', units: 3, guard: null, remoteness: 0.6 },
      ],
    });
    // 1 averages 0.15 and 3 averages 0.375: the shallower one, being less remote.
    expect(startingNodeFor(withStart(remote, ONE_STEP))).toBe(n(1));
  });

  it('follows the limit and the steps the ruleset sets', () => {
    expect(startingNodeFor(withStart(line, { NEARBY_STEPS: 1, MAX_REMOTENESS: 0.6 }))).toBe(n(6));
    // Within 3 steps, 4 and 5 reach the 0.5 site too; 2 does not.
    expect(startingNodeFor(withStart(line, { NEARBY_STEPS: 3, MAX_REMOTENESS: 0.1 }))).toBe(n(2));
  });

  it('is drawn at random from the plains spaces that are not sites, as before, on a map from before', () => {
    const before = withStart(line, undefined);
    const spaces = [1, 2, 4, 5, 6].map(n);
    for (const seed of ['a', 'b', 'c', 'd']) {
      expect(chooseStartingNode(before, createRng(seed).fork('starting-node'))).toBe(createRng(seed).fork('starting-node').pick(spaces));
    }
  });
});
