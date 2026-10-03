import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, withoutDeepStart, type Ruleset } from '@adventure/config';
import { chooseStartingNode, deepPlainsSpaces, type GameMap } from './gamemap.ts';
import { createRng } from './rng.ts';
import { fixtureMap, n } from './rules/scenario.fixture.ts';

/** Today's rules with `MIN_SPACES` deep plains spaces to start on (Q226, 856). */
const deepest = (spaces: number): Ruleset => ({
  ...DEFAULT_RULESET,
  config: { ...DEFAULT_RULESET.config, start: { MIN_SPACES: spaces, DISTANCE_SHARE: 0.5 } },
});

/**
 * A road from the forest across five plains spaces to the mountains, with a
 * site off its middle and one more plains space beyond the site. Road steps to
 * the nearest forest or mountain space: 1, 2, 3, 2 and 1 along the road, 4 for
 * the site and 5 beyond it.
 */
const road = (ruleset: Ruleset): GameMap => ({
  ...fixtureMap({
    terrains: ['forest', 'plains', 'plains', 'plains', 'plains', 'plains', 'mountain', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [3, 7],
      [7, 8],
    ],
    pois: [{ node: 7, kind: 'gold', units: 1, guard: null }],
  }),
  ruleset,
});

const starts = (map: GameMap): Set<number> =>
  new Set(Array.from({ length: 60 }, (_unused, index) => chooseStartingNode(map, createRng(`start-${index}`))));

describe('the deep plains spaces (Q226)', () => {
  it('are those as many road steps from every forest and mountain space as the most that leaves enough of them (856, 857)', () => {
    const map = road(DEFAULT_RULESET);
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 1)).toEqual([n(8)]);
    // 5 steps leaves one space, 3 steps leaves two.
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 2)).toEqual([n(3), n(8)]);
    // 2 steps leaves four: more than three, as two are equally deep.
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 3)).toEqual([n(2), n(3), n(4), n(8)]);
    // Fewer plains spaces than asked for: all of them, never none.
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 10)).toEqual([n(1), n(2), n(3), n(4), n(5), n(8)]);
  });

  it('leave out sites however deep they are (859)', () => {
    const map = road(DEFAULT_RULESET);
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 2)).not.toContain(n(7));
    expect(deepPlainsSpaces(map.graph, new Set(), 2)).toEqual([n(7), n(8)]);
  });

  it('are every plains space that is not a site on a map with no forest or mountains', () => {
    const map = fixtureMap({
      terrains: ['plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [1, 2],
      ],
    });
    expect(deepPlainsSpaces(map.graph, map.poiByNode, 1)).toEqual([n(0), n(1), n(2)]);
  });
});

describe('the starting space (§6)', () => {
  it('is drawn from the deep plains spaces (Q226, 859)', () => {
    expect(starts(road(deepest(2)))).toEqual(new Set([n(3), n(8)]));
    expect(starts(road(deepest(1)))).toEqual(new Set([n(8)]));
  });

  it('is any plains space that is not a site on a map from a game started before (861)', () => {
    const before = road(withoutDeepStart(DEFAULT_RULESET));
    expect(starts(before)).toEqual(new Set([n(1), n(2), n(3), n(4), n(5), n(8)]));
    expect(chooseStartingNode(before, createRng('same'))).toBe(createRng('same').pick([1, 2, 3, 4, 5, 8].map(n)));
  });
});
