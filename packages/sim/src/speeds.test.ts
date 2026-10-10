import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type Terrain } from '@adventure/config';
import { bestRouteSteps, createRng, effectiveDistance, routeTable, type GameMap, type NodeId, type PlayerState, type PlayerStats } from '@adventure/core';
import { fixtureGame, fixtureMap, n, type PoiSpec } from '../../core/src/rules/scenario.fixture.ts';
import { closestByBestRoute, closestBySpeeds, siteOrderBySpeeds } from './speeds.ts';

/**
 * A 6 by 6 grid of mixed terrain, node `6y + x`, with thirteen sites; the
 * last corner, node 35, has an edge to nothing and a site of its own, so no
 * route from anywhere else reaches it.
 */
const SIDE = 6;
const TERRAINS: readonly Terrain[] = ['plains', 'forest', 'mountain'];
const SITES: readonly PoiSpec[] = [1, 4, 8, 11, 14, 17, 20, 22, 25, 28, 31, 33, 35].map((node, index) => ({
  node,
  kind: index % 3 === 0 ? 'gold' : index % 3 === 1 ? 'fighting' : 'stamina',
  units: 1,
  guard: null,
}));

const grid = fixtureMap({
  terrains: Array.from({ length: SIDE * SIDE }, (_, node) => TERRAINS[((node % SIDE) + 2 * Math.floor(node / SIDE)) % 3] as Terrain),
  edges: Array.from({ length: SIDE * SIDE }, (_, node) => node).flatMap((node) => {
    const x = node % SIDE;
    const y = Math.floor(node / SIDE);
    const edges: [number, number][] = [];
    if (x + 1 < SIDE) edges.push([node, node + 1]);
    if (y + 1 < SIDE) edges.push([node, node + SIDE]);
    return edges.filter(([a, b]) => a !== SIDE * SIDE - 1 && b !== SIDE * SIDE - 1);
  }),
  pois: SITES,
});

const allSites: ReadonlySet<NodeId> = new Set(grid.pois.map((poi) => poi.node));

/** Seat one of a game on `map`, standing on `from` with the given speeds and no other stat. */
function standing(map: GameMap, from: number, speeds: Partial<PlayerStats>): { map: GameMap; player: PlayerState } {
  const state = fixtureGame(map, 0);
  const seatOne = state.players[0] as PlayerState;
  return { map, player: { ...seatOne, position: n(from), stats: { ...seatOne.stats, plains_move: 0, forest_move: 0, mountain_move: 0, ...speeds } } };
}

const asState = ({ map, player }: { map: GameMap; player: PlayerState }) => ({ state: { ...fixtureGame(map, 0), map }, player });

/** The sites a route from `from` reaches, nearest first by `distance`, then weighted terrain cost, then node id: the two finders' contract, worked out by sorting. */
function rankedByHand(map: GameMap, from: NodeId, stats: PlayerStats, distance: (node: NodeId) => number): { node: NodeId; cost: number }[] {
  const costs = routeTable(map.graph, map.ruleset.config).from(from).costs;
  return map.pois
    .map((poi) => poi.node)
    .filter((node) => Number.isFinite(costs[node]))
    .map((node) => ({ node, cost: costs[node] as number, distance: distance(node) }))
    .sort((a, b) => a.distance - b.distance || a.cost - b.cost || a.node - b.node)
    .map(({ node, cost }) => ({ node, cost }));
}

/** `effectiveDistance` along the cheapest route by weighted terrain cost: `closestBySpeeds`' measure. */
function alongCheapest(map: GameMap, from: NodeId, stats: PlayerStats): (node: NodeId) => number {
  const config = map.ruleset.config;
  const steps = routeTable(map.graph, config).stepsFrom(from);
  return (node) =>
    effectiveDistance({ plains: steps.plains[node] as number, forest: steps.forest[node] as number, mountain: steps.mountain[node] as number }, stats, config);
}

/** `effectiveDistance` along the best route for the speeds: `closestByBestRoute`'s measure. */
function alongBest(map: GameMap, from: NodeId, stats: PlayerStats): (node: NodeId) => number {
  return (node) => bestRouteSteps(map.graph, from, node, stats, map.ruleset.config)?.distance ?? Number.POSITIVE_INFINITY;
}

function randomSpeeds(rng: ReturnType<typeof createRng>, limit: number): Partial<PlayerStats> {
  return { plains_move: rng.nextInt(limit), forest_move: rng.nextInt(limit), mountain_move: rng.nextInt(limit) };
}

describe('closestBySpeeds and closestByBestRoute over kept orders of the sites', () => {
  it('rank every site a route reaches nearest first, then by terrain cost, then by node, from every space at many speeds', () => {
    const rng = createRng('kept orders');
    for (let from = 0; from < SIDE * SIDE; from++) {
      for (let trial = 0; trial < 12; trial++) {
        const { state, player } = asState(standing(grid, from, randomSpeeds(rng, 5)));
        expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(rankedByHand(grid, n(from), player.stats, alongCheapest(grid, n(from), player.stats)));
        expect(closestByBestRoute(state, player, allSites, allSites.size)).toEqual(rankedByHand(grid, n(from), player.stats, alongBest(grid, n(from), player.stats)));
      }
    }
  });

  it('leave out the site no route reaches, which from its own space is the only one', () => {
    const corner = SIDE * SIDE - 1;
    const { state, player } = asState(standing(grid, 0, { plains_move: 2 }));
    expect(closestBySpeeds(state, player, allSites, allSites.size).map((candidate) => candidate.node)).not.toContain(n(corner));
    expect(closestByBestRoute(state, player, allSites, allSites.size)).toHaveLength(allSites.size - 1);
    const isolated = asState(standing(grid, corner, { plains_move: 2 }));
    expect(closestBySpeeds(isolated.state, isolated.player, allSites, allSites.size)).toEqual([{ node: n(corner), cost: 0 }]);
    expect(closestByBestRoute(isolated.state, isolated.player, allSites, allSites.size)).toEqual([{ node: n(corner), cost: 0 }]);
  });

  it('walk the kept order past sites that are not eligible, and stop at count', () => {
    const { state, player } = asState(standing(grid, 7, { forest_move: 3, mountain_move: 1 }));
    const whole = rankedByHand(grid, n(7), player.stats, alongCheapest(grid, n(7), player.stats));
    const eligible = new Set(whole.filter((_, index) => index % 2 === 1).map(({ node }) => node));
    expect(closestBySpeeds(state, player, eligible, 3)).toEqual(whole.filter(({ node }) => eligible.has(node)).slice(0, 3));
    expect(closestBySpeeds(state, player, eligible, 100)).toEqual(whole.filter(({ node }) => eligible.has(node)));
    expect(closestBySpeeds(state, player, eligible, 0)).toEqual([]);
    expect(closestBySpeeds(state, player, new Set(), 3)).toEqual([]);
  });

  it('give the same order, asked again from the same space at the same speeds after a claim elsewhere', () => {
    const { state, player } = asState(standing(grid, 14, { plains_move: 1, mountain_move: 2 }));
    const first = closestBySpeeds(state, player, allSites, allSites.size);
    const fewer = new Set([...allSites].filter((node) => node !== first[0]?.node));
    expect(closestBySpeeds(state, player, fewer, allSites.size)).toEqual(first.slice(1));
    expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(first);
  });

  it('sort by comparing where a step cost is no whole number, to the same order', () => {
    const config = grid.ruleset.config;
    const fractional: GameMap = {
      ...grid,
      ruleset: { ...grid.ruleset, config: { ...config, movement: { ...config.movement, STAMINA_COST: { plains: 1, forest: 2.5, mountain: 3 } } } },
    };
    const rng = createRng('halves');
    let halves = 0;
    for (let from = 0; from < SIDE * SIDE; from++) {
      const { state, player } = asState(standing(fractional, from, randomSpeeds(rng, 3)));
      const measure = alongCheapest(fractional, n(from), player.stats);
      const expected = rankedByHand(fractional, n(from), player.stats, measure);
      if (expected.some(({ node }) => !Number.isInteger(measure(node)))) halves += 1;
      expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(expected);
      expect(closestByBestRoute(state, player, allSites, allSites.size)).toEqual(rankedByHand(fractional, n(from), player.stats, alongBest(fractional, n(from), player.stats)));
    }
    expect(halves).toBeGreaterThan(0);
  });

  it('rank a speed past a thousand free steps a turn afresh, to the same order', () => {
    // Steep step costs, so the distances run past 64 and are sorted in two passes.
    const config = grid.ruleset.config;
    const steep: GameMap = {
      ...grid,
      ruleset: { ...grid.ruleset, config: { ...config, movement: { ...config.movement, STAMINA_COST: { plains: 7, forest: 20, mountain: 30 } } } },
    };
    for (const map of [grid, steep]) {
      for (const speeds of [{ plains_move: 1024 }, { forest_move: 2000, mountain_move: 3 }, { plains_move: 1024, forest_move: 1024, mountain_move: 1024 }]) {
        for (const from of [0, 9, 23, 34]) {
          const { state, player } = asState(standing(map, from, speeds));
          const expected = rankedByHand(map, n(from), player.stats, alongCheapest(map, n(from), player.stats));
          expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(expected);
          expect(closestByBestRoute(state, player, allSites, allSites.size)).toEqual(rankedByHand(map, n(from), player.stats, alongBest(map, n(from), player.stats)));
        }
      }
    }
    const far = alongCheapest(steep, n(0), standing(steep, 0, { plains_move: 1024 }).player.stats);
    expect([...allSites].some((node) => far(node) >= 64 && far(node) < 4096)).toBe(true);
  });

  it('answer right once more spaces and speeds have been asked than their rounds hold', () => {
    // Over two rounds of the larger store (65 536 orders each) and of the
    // smaller (4096): the orders asked for first have long been emptied.
    const early: { from: number; speeds: Partial<PlayerStats> }[] = [];
    let asked = 0;
    for (let plains = 0; plains < 16; plains++) {
      for (let forest = 0; forest < 16; forest++) {
        for (let mountain = 0; mountain < 15; mountain++) {
          for (let from = 0; from < SIDE * SIDE; from++) {
            const speeds = { plains_move: plains, forest_move: forest, mountain_move: mountain };
            const { state, player } = asState(standing(grid, from, speeds));
            const run = siteOrderBySpeeds(grid, n(from), player.stats);
            expect(run.end - run.start).toBe(from === SIDE * SIDE - 1 ? 1 : allSites.size - 1);
            if (asked < 40) early.push({ from, speeds });
            if (asked % 1009 === 0) {
              expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(rankedByHand(grid, n(from), player.stats, alongCheapest(grid, n(from), player.stats)));
            }
            if (plains < 5 && forest < 5 && mountain < 5) {
              expect(closestByBestRoute(state, player, allSites, 1)).toEqual(rankedByHand(grid, n(from), player.stats, alongBest(grid, n(from), player.stats)).slice(0, 1));
            }
            asked += 1;
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(2 * 65_536);
    for (const { from, speeds } of early) {
      const { state, player } = asState(standing(grid, from, speeds));
      expect(closestBySpeeds(state, player, allSites, allSites.size)).toEqual(rankedByHand(grid, n(from), player.stats, alongCheapest(grid, n(from), player.stats)));
      expect(closestByBestRoute(state, player, allSites, allSites.size)).toEqual(rankedByHand(grid, n(from), player.stats, alongBest(grid, n(from), player.stats)));
    }
  });
});

describe('siteOrderBySpeeds', () => {
  it('hands out the sites as indices into the map, nearest first, between start and end', () => {
    const { player } = standing(grid, 20, { forest_move: 2 });
    const run = siteOrderBySpeeds(grid, n(20), player.stats);
    const nodes: NodeId[] = [];
    for (let at = run.start; at < run.end; at++) nodes.push((grid.pois[run.order[at] as number] as { node: NodeId }).node);
    expect(nodes).toEqual(rankedByHand(grid, n(20), player.stats, alongCheapest(grid, n(20), player.stats)).map(({ node }) => node));
    expect(DEFAULT_GAME_CONFIG.balancing.CLOSE_CANDIDATE_COUNT).toBeLessThanOrEqual(nodes.length);
  });
});
