import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, TERRAINS, type Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from '../ids.ts';
import { neighbours, type MapGraph } from '../graph.ts';
import { initialStats, type MovementAllowance, type PlayerStats } from '../player.ts';
import { createRng } from '../rng.ts';
import { frontPath, routeTable, shortestPath } from '../path.ts';
import { refreshAllowance } from './movement.ts';
import { bestRoute, bestRouteSteps, bestRouteVia, effectiveDistance, turnStops, walkTurnByTurn, walkedDistance } from './bestRoute.ts';

const config = DEFAULT_GAME_CONFIG;

function graphOf(terrains: readonly Terrain[], edges: readonly (readonly [number, number])[]): MapGraph {
  const adjacency: number[][] = terrains.map(() => []);
  for (const [a, b] of edges) {
    (adjacency[a] as number[]).push(b);
    (adjacency[b] as number[]).push(a);
  }
  return {
    nodes: terrains.map((terrain, index) => ({ id: asNodeId(index), position: { x: index, y: 0 }, terrain })),
    edges: edges.map(([a, b]) => ({ a: asNodeId(a), b: asNodeId(b) })),
    adjacency: adjacency.map((list) => list.map(asNodeId)),
  };
}

/** A `side` × `side` grid of random terrain, each node joined to its right and lower neighbours. */
function randomGrid(seed: string, side: number): MapGraph {
  const rng = createRng(seed);
  const terrains = Array.from({ length: side * side }, () => rng.pick(TERRAINS));
  const edges: [number, number][] = [];
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const at = row * side + column;
      if (column + 1 < side) edges.push([at, at + 1]);
      if (row + 1 < side) edges.push([at, at + side]);
    }
  }
  return graphOf(terrains, edges);
}

const n = (value: number): NodeId => asNodeId(value);

function speeds(plains: number, forest: number, mountain: number): PlayerStats {
  return { ...initialStats(10), plains_move: plains, forest_move: forest, mountain_move: mountain };
}

function stepsOf(graph: MapGraph, path: readonly NodeId[]): { plains: number; forest: number; mountain: number } {
  const steps = { plains: 0, forest: 0, mountain: 0 };
  for (const node of path) steps[graph.nodes[node]?.terrain as Terrain]++;
  return steps;
}

/** `walkedDistance` of `path` for `stats`, from a fresh turn's free steps unless `allowance` says otherwise. */
function walked(graph: MapGraph, path: readonly NodeId[], stats: PlayerStats, allowance: MovementAllowance = refreshAllowance(stats)): number {
  return walkedDistance(walkTurnByTurn(graph, path, allowance, stats.stamina, refreshAllowance(stats), config), config);
}

/** The least of `measure` over every route from `from` to `to` that visits no node twice. */
function bruteForceBest(graph: MapGraph, from: NodeId, to: NodeId, measure: (path: readonly NodeId[]) => number): number {
  let best = Number.POSITIVE_INFINITY;
  const visited = new Set<NodeId>([from]);
  const path: NodeId[] = [];
  const walk = (at: NodeId): void => {
    if (at === to) {
      best = Math.min(best, measure(path));
      return;
    }
    for (const next of neighbours(graph, at)) {
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      walk(next);
      path.pop();
      visited.delete(next);
    }
  };
  walk(from);
  return best;
}

//   0 ── 1 ── 2 ── 3 ── 4 ── 5     plains all the way: 5 steps, 5 stamina
//   └─── 6f ── 7f ── 8f ──────┘    three forest steps and the plains target: 7 stamina
const detour = graphOf(
  ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'forest', 'forest'],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [0, 6],
    [6, 7],
    [7, 8],
    [8, 5],
  ],
);

//   0 ─ 1f ─ 2f ─ 3f ─ 4f ─ 5f ─ 6f ─ 7f ─ 8f ─ 9f    nine forest steps
//                           └ 10m … 18m ─ 19p … 28p ┘   or five forest, nine mountain, ten plains, then 8f and 9f
// Andrei's turn 13 (Q308), on ember-fjord-280: plains 11, forest 2 and mountain 4 a turn, and 21 stamina.
const turn13 = (() => {
  const terrains: Terrain[] = ['plains', ...Array<Terrain>(9).fill('forest'), ...Array<Terrain>(9).fill('mountain'), ...Array<Terrain>(10).fill('plains')];
  const edges: [number, number][] = [];
  for (let at = 0; at < 9; at++) edges.push([at, at + 1]);
  edges.push([5, 10]);
  for (let at = 10; at < 28; at++) edges.push([at, at + 1]);
  edges.push([28, 8]);
  return graphOf(terrains, edges);
})();
const turn13Stats: PlayerStats = { ...speeds(11, 2, 4), stamina: 21 };

describe('walkTurnByTurn (Q308)', () => {
  const plains = [n(1), n(2), n(3), n(4), n(5)];

  it('arrives this turn when the free steps and stamina cover the route', () => {
    expect(walkTurnByTurn(detour, plains, { plains: 2, forest: 0, mountain: 0 }, 10, { plains: 2, forest: 0, mountain: 0 }, config)).toEqual({
      turns: 1,
      staminaSpent: 3,
      allowance: { plains: 0, forest: 0, mountain: 0 },
      stamina: 7,
    });
  });

  it('goes on next turn from the step it could not pay, with the free steps refreshed', () => {
    // Two free and one paid this turn, the last two free next turn.
    expect(walkTurnByTurn(detour, plains, { plains: 2, forest: 0, mountain: 0 }, 1, { plains: 2, forest: 0, mountain: 0 }, config)).toEqual({
      turns: 2,
      staminaSpent: 1,
      allowance: { plains: 0, forest: 0, mountain: 0 },
      stamina: 0,
    });
  });

  it('rests on a turn that would walk nothing', () => {
    const none = { plains: 0, forest: 0, mountain: 0 };
    expect(walkTurnByTurn(detour, [n(1)], none, 0, none, config)).toEqual({ turns: 2, staminaSpent: 1, allowance: none, stamina: 4 });
  });

  it('starts from the free steps left this turn', () => {
    const fresh = { plains: 2, forest: 0, mountain: 0 };
    expect(walkTurnByTurn(detour, plains, { plains: 0, forest: 0, mountain: 0 }, 10, fresh, config).staminaSpent).toBe(5);
  });

  it('is a turn and nothing spent for the empty route', () => {
    const fresh = { plains: 1, forest: 1, mountain: 1 };
    expect(walkedDistance(walkTurnByTurn(detour, [], fresh, 3, fresh, config), config)).toBe(5);
  });
});

describe('turnStops (Q315)', () => {
  const plains = [n(1), n(2), n(3), n(4), n(5)];
  const none = { plains: 0, forest: 0, mountain: 0 };

  it('ends this turn where the free steps and stamina run out, and each later turn on the full speeds', () => {
    // Two free and one paid this turn, then two free a turn.
    expect(turnStops(detour, plains, { plains: 2, forest: 0, mountain: 0 }, 1, { plains: 2, forest: 0, mountain: 0 }, config)).toEqual([3, 5]);
  });

  it('is one turn when the route arrives this turn', () => {
    expect(turnStops(detour, plains, none, 10, none, config)).toEqual([5]);
  });

  it('counts a turn that walks nothing as a rest, repeating where the turn before ended', () => {
    // One paid this turn; next turn rests for 5; then four.
    expect(turnStops(detour, plains, none, 1, none, config)).toEqual([1, 1, 5]);
    // Nothing paid this turn, so End turn rests now.
    expect(turnStops(detour, plains, none, 0, none, config)).toEqual([0, 5]);
  });

  it('pays forest steps at their own price', () => {
    // 6f costs 2 of the 3 held; 7f's 2 waits for a rest; then 7f, 8f and 5 for 5 of the 6.
    expect(turnStops(detour, [n(6), n(7), n(8), n(5)], none, 3, none, config)).toEqual([1, 1, 4]);
  });

  it('has as many turns as walkTurnByTurn counts, on random routes', () => {
    const grid = randomGrid('turn-stops', 7);
    const rng = createRng('turn-stops-routes');
    for (let trial = 0; trial < 200; trial++) {
      const from = n(rng.nextIntInclusive(0, grid.nodes.length - 1));
      const to = n(rng.nextIntInclusive(0, grid.nodes.length - 1));
      const path = shortestPath(grid, from, to, config) ?? [];
      const fresh = { plains: rng.nextIntInclusive(0, 2), forest: rng.nextIntInclusive(0, 2), mountain: rng.nextIntInclusive(0, 1) };
      const left = { plains: rng.nextIntInclusive(0, fresh.plains), forest: rng.nextIntInclusive(0, fresh.forest), mountain: rng.nextIntInclusive(0, fresh.mountain) };
      const stamina = rng.nextIntInclusive(0, 12);
      const stops = turnStops(grid, path, left, stamina, fresh, config);
      expect(stops.length).toBe(walkTurnByTurn(grid, path, left, stamina, fresh, config).turns);
      expect(stops[stops.length - 1]).toBe(path.length);
    }
  });
});

describe('bestRoute (Q210, 811 A; Q308)', () => {
  it('takes the forest on free steps when the player has the forest speed for it', () => {
    const stats = speeds(0, 3, 0);
    expect(shortestPath(detour, n(0), n(5), config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
    expect(bestRoute(detour, n(0), n(5), stats, refreshAllowance(stats), config)).toEqual([n(6), n(7), n(8), n(5)]);
  });

  it('walks nine forest steps this turn where the formula took a 26-step loop over two (Andrei’s turn 13)', () => {
    const forest = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n);
    const loop = [1, 2, 3, 4, 5, ...Array.from({ length: 19 }, (_, at) => 10 + at), 8, 9].map(n);
    // The formula counts the loop 17 and the forest 19, as the game drew it.
    expect(bestRouteSteps(turn13, n(0), n(9), turn13Stats, config)).toMatchObject({ steps: stepsOf(turn13, loop), distance: 17 });
    expect(walked(turn13, loop, turn13Stats)).toBe(5 * 2 + 21);
    expect(walked(turn13, forest, turn13Stats)).toBe(5 + 14);
    expect(bestRoute(turn13, n(0), n(9), turn13Stats, refreshAllowance(turn13Stats), config)).toEqual(forest);
  });

  it('picks from the free steps left this turn', () => {
    const stats = speeds(0, 3, 0);
    // With the forest steps spent, paying for the plains is cheaper.
    expect(bestRoute(detour, n(0), n(5), stats, { plains: 0, forest: 0, mountain: 0 }, config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
  });

  it('picks by the stamina held', () => {
    // With none, the forest's free steps stop a step short and two turns go before
    // the last is paid; the plains rest once and are paid the next turn: 16 against 15.
    const stats = { ...speeds(0, 3, 0), stamina: 0 };
    expect(walked(detour, [n(6), n(7), n(8), n(5)], stats)).toBe(16);
    expect(walked(detour, [n(1), n(2), n(3), n(4), n(5)], stats)).toBe(15);
    expect(bestRoute(detour, n(0), n(5), stats, refreshAllowance(stats), config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
  });

  it('keeps today’s route when another is only as good, not better', () => {
    // Plains speed 1 and forest speed 1 make both routes walk 9: 5 + 4 and 5 + 2 + 2.
    const stats = speeds(1, 1, 0);
    expect(walked(detour, [n(1), n(2), n(3), n(4), n(5)], stats)).toBe(walked(detour, [n(6), n(7), n(8), n(5)], stats));
    expect(bestRoute(detour, n(0), n(5), stats, refreshAllowance(stats), config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
  });

  it('is the empty route on the spot, and null where nothing reaches', () => {
    const stats = speeds(1, 1, 1);
    expect(bestRoute(detour, n(3), n(3), stats, refreshAllowance(stats), config)).toEqual([]);
    const apart = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(bestRoute(apart, n(0), n(2), stats, refreshAllowance(stats), config)).toBeNull();
  });

  it('is exactly today’s route from every node to every node when the player has no speeds and stamina for the whole way', () => {
    const graph = randomGrid('best-route-zero', 7);
    const routes = routeTable(graph, config);
    const stats = { ...speeds(0, 0, 0), stamina: 1000 };
    for (let from = 0; from < graph.nodes.length; from += 5) {
      for (let to = 0; to < graph.nodes.length; to++) {
        expect(bestRoute(graph, n(from), n(to), stats, refreshAllowance(stats), config)).toEqual(routes.path(n(from), n(to)));
      }
    }
  });

  it('walks as well as the best route it weighs, and no worse than the cheapest, on random terrain, speeds and stamina', () => {
    const rng = createRng('best-route-weighed');
    for (let round = 0; round < 8; round++) {
      const graph = randomGrid(`best-route-${round}`, 6);
      const stats = { ...speeds(rng.nextIntInclusive(0, 4), rng.nextIntInclusive(0, 3), rng.nextIntInclusive(0, 3)), stamina: rng.nextIntInclusive(0, 25) };
      const front = routeTable(graph, config).routesFrom(n(0));
      for (let to = 1; to < graph.nodes.length; to++) {
        const route = bestRoute(graph, n(0), n(to), stats, refreshAllowance(stats), config) ?? [];
        const today = shortestPath(graph, n(0), n(to), config) ?? [];
        let best = walked(graph, today, stats);
        for (let entry = front.start[to] as number; entry < (front.start[to + 1] as number); entry++) {
          best = Math.min(best, walked(graph, frontPath(front, entry), stats));
        }
        expect(walked(graph, route, stats)).toBe(best);
      }
    }
  });

  it('draws a route as good whatever order the adjacency lists are in', () => {
    const graph = randomGrid('best-route-order', 6);
    const reversed: MapGraph = { ...graph, adjacency: graph.adjacency.map((list) => [...list].reverse()) };
    const stats = speeds(1, 2, 2);
    for (let to = 0; to < graph.nodes.length; to++) {
      const one = bestRoute(graph, n(0), n(to), stats, refreshAllowance(stats), config) ?? [];
      const other = bestRoute(reversed, n(0), n(to), stats, refreshAllowance(stats), config) ?? [];
      expect(walked(reversed, other, stats)).toBe(walked(graph, one, stats));
    }
  });
});

describe('RouteTable.routesFrom (Q210)', () => {
  it('starts each node’s routes with one as cheap as any by terrain alone, and keeps none another beats everywhere', () => {
    const graph = randomGrid('route-front', 6);
    const routes = routeTable(graph, config);
    const front = routes.routesFrom(n(0));
    for (let node = 1; node < graph.nodes.length; node++) {
      const first = front.start[node] as number;
      const last = front.start[node + 1] as number;
      expect(last).toBeGreaterThan(first);
      const cost = (entry: number): number =>
        (front.plains[entry] as number) + 2 * (front.forest[entry] as number) + 3 * (front.mountain[entry] as number);
      expect(cost(first)).toBe(routes.from(n(0)).costs[node]);
      for (let a = first; a < last; a++) {
        for (let b = first; b < last; b++) {
          if (a === b) continue;
          const beats =
            (front.plains[a] as number) <= (front.plains[b] as number) &&
            (front.forest[a] as number) <= (front.forest[b] as number) &&
            (front.mountain[a] as number) <= (front.mountain[b] as number);
          expect(beats).toBe(false);
        }
      }
    }
  });
});

describe('bestRouteVia (Q210, 812 A; Q308)', () => {
  it('goes through the waypoint, each leg the best for the player', () => {
    const stats = speeds(0, 3, 0);
    const fresh = refreshAllowance(stats);
    expect(bestRouteVia(detour, n(0), n(7), n(3), stats, fresh, config)).toEqual([
      ...(bestRoute(detour, n(0), n(7), stats, fresh, config) ?? []),
      ...(bestRoute(detour, n(7), n(3), stats, { plains: 0, forest: 1, mountain: 0 }, config) ?? []),
    ]);
    expect(bestRouteVia(detour, n(0), null, n(5), stats, fresh, config)).toEqual(bestRoute(detour, n(0), n(5), stats, fresh, config));
  });

  it('picks the leg onward from where the first leaves the walk', () => {
    //   0 ── 1f ── 2f ── 4p      the forest step is free on a fresh turn, not once the first leg has used it
    //         └─── 3p ───┘
    const graph = graphOf(['plains', 'forest', 'forest', 'plains', 'plains'], [[0, 1], [1, 2], [2, 4], [1, 3], [3, 4]]);
    const stats = speeds(0, 1, 0);
    const fresh = refreshAllowance(stats);
    expect(bestRoute(graph, n(1), n(4), stats, fresh, config)).toEqual([n(2), n(4)]);
    expect(bestRouteVia(graph, n(0), n(1), n(4), stats, fresh, config)).toEqual([n(1), n(3), n(4)]);
  });
});

describe('bestRouteSteps (Q210, 820 A)', () => {
  it('gives the least effective distance of every route there is, and the steps of a route with it', () => {
    const rng = createRng('best-route-steps');
    for (let round = 0; round < 6; round++) {
      const graph = randomGrid(`best-route-steps-${round}`, 4);
      const stats = speeds(rng.nextIntInclusive(0, 3), rng.nextIntInclusive(0, 3), rng.nextIntInclusive(0, 3));
      for (let to = 1; to < graph.nodes.length; to++) {
        const choice = bestRouteSteps(graph, n(0), n(to), stats, config);
        const today = shortestPath(graph, n(0), n(to), config) ?? [];
        expect(choice?.distance).toBe(bruteForceBest(graph, n(0), n(to), (path) => effectiveDistance(stepsOf(graph, path), stats, config)));
        expect(choice?.distance).toBe(effectiveDistance(choice?.steps ?? stepsOf(graph, today), stats, config));
        expect(choice?.distance).toBeLessThanOrEqual(effectiveDistance(stepsOf(graph, today), stats, config));
      }
    }
  });

  it('keeps its answers for each set of speeds apart', () => {
    const forest = { plains: 1, forest: 3, mountain: 0 };
    const plains = { plains: 5, forest: 0, mountain: 0 };
    expect(bestRouteSteps(detour, n(0), n(5), speeds(0, 3, 0), config)?.steps).toEqual(forest);
    expect(bestRouteSteps(detour, n(0), n(5), speeds(0, 0, 0), config)?.steps).toEqual(plains);
    expect(bestRouteSteps(detour, n(0), n(5), { ...speeds(0, 3, 0), gold: 7, stamina: 2 }, config)?.steps).toEqual(forest);
  });

  it('is no steps on the spot, and null where nothing reaches', () => {
    expect(bestRouteSteps(detour, n(3), n(3), speeds(1, 1, 1), config)).toEqual({
      steps: { plains: 0, forest: 0, mountain: 0 },
      distance: 5,
      entry: -1,
    });
    const apart = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(bestRouteSteps(apart, n(0), n(2), speeds(1, 1, 1), config)).toBeNull();
  });
});
