import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, type Ruleset } from '@adventure/config';
import { chooseStartingNode, type GameMap } from './gamemap.ts';
import { createRng } from './rng.ts';
import { fixtureMap, n } from './rules/scenario.fixture.ts';

/** The rules a game started before the start moved away from the forest played by (Q225, 853). */
const BEFORE: Ruleset = (() => {
  const { start: _start, ...config } = DEFAULT_RULESET.config;
  return { ...DEFAULT_RULESET, config };
})();

/** A road from the forest across five plains spaces to the mountains, and a site on a side road. */
const road: GameMap = {
  ...fixtureMap({
    terrains: ['forest', 'plains', 'plains', 'plains', 'plains', 'plains', 'mountain', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [3, 7],
    ],
    pois: [{ node: 7, kind: 'gold', units: 1, guard: null }],
  }),
  ruleset: DEFAULT_RULESET,
};

const starts = (map: GameMap): Set<number> =>
  new Set(Array.from({ length: 40 }, (_unused, index) => chooseStartingNode(map, createRng(`start-${index}`))));

describe('the starting space (§6)', () => {
  it('is in the farther half from the forest by stamina, never one step from the mountains (Q225, 850 A, 855 3)', () => {
    // Stamina to the forest: 2, 3, 4, 5 and 6 from spaces 1 to 5; the farther
    // half, rounded up, is 3, 4 and 5, and 5 is one step from the mountains.
    expect(starts(road)).toEqual(new Set([n(3), n(4)]));
  });

  it('is the whole farther half from the forest when every space in it is next to the mountains (852)', () => {
    const short: GameMap = {
      ...fixtureMap({
        terrains: ['forest', 'plains', 'plains', 'mountain'],
        edges: [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
      }),
      ruleset: DEFAULT_RULESET,
    };
    expect(starts(short)).toEqual(new Set([n(2)]));
  });

  it('is any plains space that is not a site on a map from a game started before (853)', () => {
    const before = { ...road, ruleset: BEFORE };
    expect(starts(before)).toEqual(new Set([n(1), n(2), n(3), n(4), n(5)]));
    expect(chooseStartingNode(before, createRng('same'))).toBe(createRng('same').pick([1, 2, 3, 4, 5].map(n)));
  });
});
