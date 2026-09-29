import type { MapEdge, Point } from '@adventure/core';
import { rebuildAdjacency } from '../graphops.ts';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 6b — "Join borders: put pruned roads back where two terrain areas
 * meet in fewer than `BORDER_ROAD_PLACES` places."
 *
 * **Why the step exists.** [SOURCE §2.1 step 6b, chat] Step 3 leaves a graph
 * that is nearly a tree, and step 4 grows terrain along its roads, so a terrain
 * stops exactly where roads are fewest. Measured over 100 maps before this step
 * existed: 12% had no road at all between plains and forest, 22% had two or
 * fewer, and only 77% of forest spaces could be reached from plains without
 * stepping on a mountain. The triangulation still has plenty of edges across
 * each of those borders; pruning simply took them. Keeping more roads
 * everywhere does not work — at 330 roads most maps fall under `LEAF_COUNT.min`
 * and regenerate, and at 360 none can be made.
 *
 * **What it does.** An *area* is a set of spaces of one terrain joined by
 * roads. For every two areas that touch in the triangulation, it counts the
 * separate places their roads cross (roads that share a space are one place)
 * and puts pruned triangulation edges back until there are
 * `BORDER_ROAD_PLACES` of them, or it runs out of edges that qualify
 * (OPEN_QUESTIONS Q105):
 *
 * - both areas have at least `BORDER_AREA_MIN_SIZE` spaces (395);
 * - the edge is no longer than `BORDER_ROAD_MAX_LENGTH` times the longest road
 *   step 3 kept (393);
 * - it does not share a space with a crossing the border already has, since
 *   that would widen a place rather than add one;
 * - it prefers edges that leave every dead end a dead end, and takes one that
 *   joins a dead end only while at least `LEAF_COUNT.min` dead ends remain
 *   (392) — so step 8's leaf test still holds;
 * - with no crossing yet it takes the shortest edge; after that the one
 *   farthest from the border's existing crossings, so crossings spread out
 *   along the border (396).
 *
 * Two pieces of the same terrain that touch on the ground but share no road
 * are joined the same way, with `JOINED_PIECE_ROADS` places (394). Valley
 * spaces are treated like any other (397).
 *
 * The step draws nothing from the `Rng` and leaves terrain alone: it only adds
 * roads, all of them edges step 2 drew, so the map stays planar and connected.
 * Areas are worked out once, before anything is added, and pairs are handled in
 * a fixed order, so the result is a function of the draft alone.
 */
export const joinBordersStep: GenerationStep = {
  id: '6b-join-borders',
  gdd: 'GDD.md §2.1 step 6b',
  run(draft: MapDraft, context: GenerationContext): void {
    const added = borderRoadsToAdd(draft, context);
    if (added.length === 0) return;
    draft.edges = [...draft.edges, ...added].sort((left, right) =>
      left.a !== right.a ? left.a - right.a : left.b - right.b,
    );
    rebuildAdjacency(draft);
  },
};

function borderRoadsToAdd(draft: MapDraft, context: GenerationContext): MapEdge[] {
  const { BORDER_ROAD_PLACES, BORDER_AREA_MIN_SIZE, BORDER_ROAD_MAX_LENGTH, JOINED_PIECE_ROADS, LEAF_COUNT } =
    context.ruleset.config.map;
  const stride = draft.positions.length;
  const keyOf = (edge: MapEdge) => edge.a * stride + edge.b;
  const roads = new Set(draft.edges.map(keyOf));
  const length = (edge: MapEdge) => {
    const from = draft.positions[edge.a] as Point;
    const to = draft.positions[edge.b] as Point;
    return Math.hypot(from.x - to.x, from.y - to.y);
  };
  const longestRoad = Math.max(...draft.edges.map(length));
  const { area, size } = terrainAreas(draft);
  const pairOf = (edge: MapEdge): [number, number] => {
    const x = area[edge.a] as number;
    const y = area[edge.b] as number;
    return x < y ? [x, y] : [y, x];
  };
  const pairKey = ([x, y]: [number, number]) => x * stride + y;

  // Crossings each pair of areas already has. Two pieces of one terrain never
  // do: a road between them would have made them one area.
  const crossings = new Map<number, MapEdge[]>();
  for (const edge of draft.edges) {
    if (draft.terrain[edge.a] === draft.terrain[edge.b]) continue;
    const key = pairKey(pairOf(edge));
    crossings.set(key, [...(crossings.get(key) ?? []), edge]);
  }

  // Pruned edges that could go back, grouped by the pair of areas they join.
  const candidates = new Map<number, { pair: [number, number]; edges: MapEdge[] }>();
  for (const edge of draft.triangulation) {
    if (roads.has(keyOf(edge))) continue;
    const pair = pairOf(edge);
    if (pair[0] === pair[1]) continue;
    if ((size[pair[0]] as number) < BORDER_AREA_MIN_SIZE || (size[pair[1]] as number) < BORDER_AREA_MIN_SIZE) continue;
    if (length(edge) > longestRoad * BORDER_ROAD_MAX_LENGTH) continue;
    const key = pairKey(pair);
    const entry = candidates.get(key) ?? { pair, edges: [] };
    entry.edges.push(edge);
    candidates.set(key, entry);
  }

  const degree = draft.adjacency.map((neighbours) => neighbours.length);
  let deadEnds = degree.filter((count) => count === 1).length;
  const deadEndsOn = (edge: MapEdge) => (degree[edge.a] === 1 ? 1 : 0) + (degree[edge.b] === 1 ? 1 : 0);
  const added: MapEdge[] = [];

  for (const key of [...candidates.keys()].sort((left, right) => left - right)) {
    const { pair, edges } = candidates.get(key) as { pair: [number, number]; edges: MapEdge[] };
    const first = edges[0] as MapEdge;
    const sameTerrain = draft.terrain[first.a] === draft.terrain[first.b];
    const target = sameTerrain ? JOINED_PIECE_ROADS : BORDER_ROAD_PLACES;
    const current = [...(crossings.get(pairKey(pair)) ?? [])];
    let pool = edges;

    while (places(current) < target) {
      pool = pool.filter((edge) => deadEnds - deadEndsOn(edge) >= LEAF_COUNT.min);
      let best: { edge: MapEdge; joinsDeadEnd: boolean; score: number } | null = null;
      for (const edge of pool) {
        if (current.some((crossing) => sharesASpace(crossing, edge))) continue;
        const joinsDeadEnd = deadEndsOn(edge) > 0;
        const score =
          current.length === 0
            ? -length(edge)
            : Math.min(...current.map((crossing) => distance(midpoint(draft, crossing), midpoint(draft, edge))));
        if (best === null || isBetter(joinsDeadEnd, score, edge, best)) best = { edge, joinsDeadEnd, score };
      }
      if (best === null) break;
      const chosen = best.edge;
      pool = pool.filter((edge) => edge !== chosen);
      deadEnds -= deadEndsOn(chosen);
      degree[chosen.a] = (degree[chosen.a] as number) + 1;
      degree[chosen.b] = (degree[chosen.b] as number) + 1;
      current.push(chosen);
      added.push(chosen);
    }
  }
  return added;
}

/** A road that joins no dead end beats one that does; then the higher score; then the lower `(a, b)`. */
function isBetter(
  joinsDeadEnd: boolean,
  score: number,
  edge: MapEdge,
  best: { edge: MapEdge; joinsDeadEnd: boolean; score: number },
): boolean {
  if (joinsDeadEnd !== best.joinsDeadEnd) return !joinsDeadEnd;
  if (score !== best.score) return score > best.score;
  return edge.a !== best.edge.a ? edge.a < best.edge.a : edge.b < best.edge.b;
}

/**
 * Areas: spaces of one terrain joined by roads, numbered in order of their
 * lowest space. Measured once, on the draft step 6 hands over.
 */
export function terrainAreas(draft: MapDraft): { area: number[]; size: number[] } {
  const area = new Array<number>(draft.terrain.length).fill(-1);
  const size: number[] = [];
  for (let start = 0; start < draft.terrain.length; start++) {
    if (area[start] !== -1) continue;
    const id = size.length;
    const queue: number[] = [start];
    area[start] = id;
    for (let head = 0; head < queue.length; head++) {
      for (const neighbour of draft.adjacency[queue[head] as number] ?? []) {
        if (area[neighbour] !== -1 || draft.terrain[neighbour] !== draft.terrain[start]) continue;
        area[neighbour] = id;
        queue.push(neighbour);
      }
    }
    size.push(queue.length);
  }
  return { area, size };
}

/** Separate places a set of crossings makes: crossings that share a space, directly or in a chain, are one place. */
export function places(crossings: readonly MapEdge[]): number {
  const parent = crossings.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) index = parent[index] as number;
    return index;
  };
  for (let i = 0; i < crossings.length; i++) {
    for (let j = i + 1; j < crossings.length; j++) {
      if (sharesASpace(crossings[i] as MapEdge, crossings[j] as MapEdge)) parent[find(i)] = find(j);
    }
  }
  return new Set(crossings.map((_, index) => find(index))).size;
}

function sharesASpace(left: MapEdge, right: MapEdge): boolean {
  return left.a === right.a || left.a === right.b || left.b === right.a || left.b === right.b;
}

function midpoint(draft: MapDraft, edge: MapEdge): Point {
  const from = draft.positions[edge.a] as Point;
  const to = draft.positions[edge.b] as Point;
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
