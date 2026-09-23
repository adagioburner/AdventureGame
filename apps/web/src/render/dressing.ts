import { TERRAINS, type Terrain } from '@adventure/config';
import { createRng, type GameMap, type Point, type Rng } from '@adventure/core';
import { atlasOf, wrapIndex, type ArtCatalog } from '../art/catalog.ts';
import type { ArtManifest, DressingArt } from '../art/manifest.ts';
import { distance, distanceToSegment, ObstacleGrid, position } from './geometry.ts';
import type { Bounds, Projection } from './isometric.ts';
import { grow, pictureBox, type ShapeOf, type SpriteShape } from './placement.ts';
import { SPACING_PX, type Billboard } from './sceneModel.ts';

/**
 * [SOURCE §6] "non-interactive dressing (eye candy) are billboard sprites
 * pasted onto the map by the engine."
 *
 * Two kinds, as the manifest marks them. Standing dressing (trees, grass,
 * fields) stands up among the POIs and figures and is kept clear of every
 * node and road. Backdrop dressing (the mountains) is painted onto the ground
 * under the roads and nodes and fills its whole terrain. Both come from
 * streams forked off the map seed, so the same map always carries the same
 * trees and the same mountains.
 */

/** The terrains whose ground is covered by backdrop dressing. */
export function backdropTerrains(manifest: ArtManifest): Set<Terrain> {
  return new Set(TERRAINS.filter((terrain) => manifest.terrain[terrain].dressing.some((d) => d.layer === 'backdrop')));
}

/** How far a standing sprite's picture reaches past its measured shape when it is kept off nodes and roads, as a share of its size. */
export const STANDING_MARGIN = 0.05;

/** How far apart backdrop sprites are sown, as a share of their largest size. */
export const BACKDROP_STEP = 0.4;

/** How far apart two sprites of one array stand, as a share of the gap that would put them edge to edge. */
const ARRAY_GAP = 1.04;

interface Ground {
  readonly map: GameMap;
  readonly catalog: ArtCatalog;
  readonly projection: Projection;
  readonly spacing: number;
  readonly bounds: Bounds;
  readonly shapeOf: ShapeOf;
}

function nearestNode(map: GameMap, at: Point): { terrain: Terrain; distance: number } | null {
  let best: { terrain: Terrain; distance: number } | null = null;
  for (const node of map.graph.nodes) {
    const d = distance(at, node.position);
    if (best === null || d < best.distance) best = { terrain: node.terrain, distance: d };
  }
  return best;
}

function inside(bounds: Bounds, at: Point): boolean {
  return at.x >= bounds.min.x && at.x <= bounds.max.x && at.y >= bounds.min.y && at.y <= bounds.max.y;
}

function pick(options: readonly DressingArt[], roll: number): DressingArt | undefined {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let left = roll * total;
  return options.find((candidate) => (left -= candidate.weight) < 0) ?? options[options.length - 1];
}

/**
 * Standing dressing, scattered over each terrain at the manifest's density
 * and rejected wherever it would stand on a road, stand on a node, or hide a
 * node or road standing behind it — so it is never in the way of the game.
 *
 * A sheet with an `array` is laid out as a small grid of sprites side by
 * side along the ground instead of one at a time: [Andrei, review
 * 2026-09-23] fields "look the best when placed in arrays, several at a
 * time". A cell of an array that breaks a rule is left out, and an array left
 * with fewer than two sprites is not placed at all.
 */
export function placeDressing(ground: Ground): Billboard[] {
  const { map, catalog, projection, spacing, bounds, shapeOf } = ground;
  const { manifest } = catalog;
  const graph = map.graph;
  const rng = createRng(map.seed).fork('dressing');

  // What standing dressing must not cover, in screen space: every node and every road.
  const obstacles = new ObstacleGrid(SPACING_PX);
  for (const node of graph.nodes) obstacles.addPoint(projection.toScreen(node.position));
  for (const edge of graph.edges) {
    obstacles.addSegment(projection.toScreen(position(graph, edge.a)), projection.toScreen(position(graph, edge.b)));
  }

  const quota = new Map<Terrain, number>();
  for (const terrain of TERRAINS) {
    const count = graph.nodes.filter((node) => node.terrain === terrain).length;
    quota.set(terrain, Math.round(count * manifest.terrain[terrain].dressingDensity));
  }
  const wanted = [...quota.values()].reduce((sum, n) => sum + n, 0);

  const placed: Billboard[] = [];
  /** Where each array's sprites stand on the ground, so two arrays never overlap. */
  const arrays: { at: Point; step: number }[] = [];
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  /** The billboard for a standing sprite at `at`, or `null` where it would be in the way. */
  const stand = (at: Point, option: DressingArt, terrain: Terrain, spriteRoll: number): Billboard | null => {
    if (!inside(bounds, at)) return null;
    const nearest = nearestNode(map, at);
    if (nearest === null || nearest.terrain !== terrain) return null;
    if (nearest.distance < spacing * 0.3) return null;
    if (graph.edges.some((edge) => distanceToSegment(at, position(graph, edge.a), position(graph, edge.b)) < spacing * 0.14)) {
      return null;
    }
    const size = option.size * SPACING_PX;
    const foot = projection.toScreen(at);
    const sprite = { sheet: option.sheet, index: wrapIndex(spriteRoll, atlasOf(catalog, option.sheet).sprites.length) };
    // The picture rises above its foot; a node or road inside it would be hidden.
    const box = grow(pictureBox(foot, size, shapeOf(sprite)), size * STANDING_MARGIN);
    if (obstacles.anyInBox(box.minX, box.minY, box.maxX, box.maxY)) return null;
    return { layer: 'dressing', sprite, foot, size, node: null, depth: foot.y };
  };

  for (let attempt = 0; attempt < wanted * 40 && placed.length < wanted; attempt++) {
    const at = { x: bounds.min.x + rng.nextFloat() * width, y: bounds.min.y + rng.nextFloat() * height };
    const pickDressing = rng.nextFloat();
    const pickSprite = rng.nextUint32();

    const nearest = nearestNode(map, at);
    if (nearest === null) break;
    const left = quota.get(nearest.terrain) ?? 0;
    if (left <= 0) continue;
    const option = pick(
      manifest.terrain[nearest.terrain].dressing.filter((d) => d.layer === 'standing'),
      pickDressing,
    );
    if (option === undefined) continue;

    if (option.array <= 1) {
      const item = stand(at, option, nearest.terrain, pickSprite);
      if (item === null) continue;
      placed.push(item);
      quota.set(nearest.terrain, left - 1);
      continue;
    }

    const cells = arrayCells(rng, option.array);
    // Side by side along the ground's two axes: a sprite as wide on screen
    // as its typical span covers a ground square this many units a side.
    const step = ((option.size * SPACING_PX) / (2 * projection.matrix.a)) * ARRAY_GAP;
    const kept: { cell: [number, number]; spot: Point; item: Billboard }[] = [];
    for (const cell of cells) {
      const spot = { x: at.x + cell[0] * step, y: at.y + cell[1] * step };
      if (arrays.some((other) => distance(spot, other.at) < Math.max(step, other.step) * 0.95)) continue;
      const item = stand(spot, option, nearest.terrain, rng.nextUint32());
      if (item !== null) kept.push({ cell, spot, item });
    }
    // A sprite whose neighbours were all left out would stand apart from
    // its array, so it goes too.
    const joined = kept.filter(({ cell: [i, j] }) =>
      kept.some(({ cell: [k, l] }) => Math.abs(i - k) + Math.abs(j - l) === 1),
    );
    if (joined.length < 2) continue;
    for (const { spot, item } of joined) {
      placed.push(item);
      arrays.push({ at: spot, step });
    }
    quota.set(nearest.terrain, left - joined.length);
  }
  return placed;
}

/** The cells of one array: a random rectangle up to `most` a side, never a single sprite. */
function arrayCells(rng: Rng, most: number): [number, number][] {
  let columns = 1 + Math.floor(rng.nextFloat() * most);
  const rows = 1 + Math.floor(rng.nextFloat() * most);
  if (columns * rows < 2) columns = 2;
  const cells: [number, number][] = [];
  for (let i = 0; i < columns; i++) for (let j = 0; j < rows; j++) cells.push([i, j]);
  return cells;
}

/**
 * Screen points on a backdrop sprite's outline that must all lie over its own
 * terrain: its base, its sides half way and three quarters up, and its peak.
 * The picture is treated as a steep triangle, as a mountain is; the renderer
 * also clips the backdrop to its terrain, so what the triangle misses is cut
 * off there.
 */
export function silhouettePoints(foot: Point, size: number, shape: SpriteShape): Point[] {
  const left = shape.left * size;
  const right = shape.right * size;
  const top = shape.top * size;
  const bottom = shape.bottom * size;
  const middle = (left + right) / 2;
  const at = (x: number, y: number): Point => ({ x: foot.x + x, y: foot.y + y });
  const half = (top + bottom) / 2;
  return [
    at(left * 0.9, bottom),
    at(middle, bottom),
    at(right * 0.9, bottom),
    at(left * 0.75, half),
    at(right * 0.75, half),
    at(left * 0.4, top * 0.75),
    at(right * 0.4, top * 0.75),
    at(middle, top * 0.95),
  ];
}

/**
 * [Andrei, review 2026-09-23] "mountain images should pretty much cover the
 * whole mountain region, without gaps when possible, but not stick out of
 * it. For this, mountains can be resized to fit the necessary space."
 *
 * Sown over every backdrop terrain on a jittered grid `BACKDROP_STEP` of the
 * largest size apart. Each sprite takes the largest size, between the sheet's
 * `min_size` and `size`, at which its silhouette lies wholly over its own
 * terrain; a spot where not even the smallest fits is left bare.
 */
export function placeBackdrop(ground: Ground): Billboard[] {
  const { map, catalog, projection, spacing, bounds, shapeOf } = ground;
  const { manifest } = catalog;
  const rng = createRng(map.seed).fork('backdrop');
  const terrains = backdropTerrains(manifest);
  if (terrains.size === 0) return [];

  const options = new Map(
    [...terrains].map((terrain) => [terrain, manifest.terrain[terrain].dressing.filter((d) => d.layer === 'backdrop')]),
  );
  const largest = Math.max(...[...options.values()].flat().map((d) => d.size));
  const step = largest * spacing * BACKDROP_STEP;
  const over = (terrain: Terrain) => (screen: Point): boolean => {
    const at = projection.toWorld(screen);
    return inside(bounds, at) && nearestNode(map, at)?.terrain === terrain;
  };

  const placed: Billboard[] = [];
  for (let gy = bounds.min.y; gy < bounds.max.y; gy += step) {
    for (let gx = bounds.min.x; gx < bounds.max.x; gx += step) {
      const at = { x: gx + rng.nextFloat() * step, y: gy + rng.nextFloat() * step };
      const pickDressing = rng.nextFloat();
      const pickSprite = rng.nextUint32();
      const shrink = rng.nextFloat();
      if (!inside(bounds, at)) continue;
      const terrain = nearestNode(map, at)?.terrain;
      if (terrain === undefined || !terrains.has(terrain)) continue;
      const option = pick(options.get(terrain) ?? [], pickDressing);
      if (option === undefined) continue;

      const foot = projection.toScreen(at);
      const sprite = { sheet: option.sheet, index: wrapIndex(pickSprite, atlasOf(catalog, option.sheet).sprites.length) };
      const shape = shapeOf(sprite);
      const fits = over(terrain);
      // A little variety in the middle of a range, then as large as fits.
      let size = option.size * (0.85 + 0.15 * shrink);
      while (size >= option.minSize && !silhouettePoints(foot, size * SPACING_PX, shape).every(fits)) size *= 0.9;
      if (size < option.minSize) {
        size = option.minSize;
        if (!silhouettePoints(foot, size * SPACING_PX, shape).every(fits)) continue;
      }
      placed.push({ layer: 'backdrop', sprite, foot, size: size * SPACING_PX, node: null, depth: foot.y });
    }
  }
  return placed;
}
