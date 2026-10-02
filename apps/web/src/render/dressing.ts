import { TERRAINS, type Terrain } from '@adventure/config';
import { createRng, type GameMap, type Point } from '@adventure/core';
import { atlasOf, wrapIndex, type ArtCatalog, type SpriteRef } from '../art/catalog.ts';
import type { ArtManifest, DressingArt } from '../art/manifest.ts';
import { distance, distanceToSegment, ObstacleGrid, position } from './geometry.ts';
import type { Bounds, Projection } from './isometric.ts';
import { grow, overlapArea, pictureBands, pictureBox, type Box, type ShapeOf, type SpriteShape } from './placement.ts';
import { SPACING_PX, type Billboard } from './sceneModel.ts';

/**
 * [SOURCE §6] "non-interactive dressing (eye candy) are billboard sprites
 * pasted onto the map by the engine."
 *
 * Two kinds, as the manifest marks them. Standing dressing (trees, bushes,
 * grass, rocks) stands up among the POIs and figures and is kept clear of every
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

/** How far apart backdrop spots are sown, as a share of the smallest size a backdrop sprite may take. */
export const BACKDROP_STEP = 0.6;

/**
 * How far apart two sprites of one cluster stand, as a share of the gap that
 * would put their ground footprints edge to edge: below 1, so they touch and
 * the one in front hides the foot of the one behind.
 */
export const CLUSTER_TOUCH = 0.75;

/** How many directions a sprite of a cluster tries before it settles for crowding its neighbours. */
const CLUSTER_TRIES = 8;

/**
 * [710] The share of the trees between the outermost roads and the ground's
 * edge that stay: each stays by this chance, the rest are planted in the
 * middle of the forest instead (711).
 */
export const EDGE_TREES_KEPT = 1 / 3;

/**
 * [711] How many spots in the middle of the forest are tried for each tree
 * taken off the edge before the ones that have not fitted are dropped.
 */
export const MIDDLE_TRIES = 40;

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

/** One of a dressing sheet's sprites, any but those the manifest leaves out. */
function dressingSprite(catalog: ArtCatalog, option: DressingArt, roll: number): SpriteRef {
  const kept = atlasOf(catalog, option.sheet)
    .sprites.map((sprite, index) => ({ id: sprite.id, index }))
    .filter((sprite) => !option.leaveOut.includes(sprite.id));
  return { sheet: option.sheet, index: kept[wrapIndex(roll, kept.length)]?.index ?? 0 };
}

/** The indices of a dressing sheet's clustered sprites, in the manifest's order. */
function clusteredSprites(catalog: ArtCatalog, option: DressingArt): number[] {
  const sprites = atlasOf(catalog, option.sheet).sprites;
  return (option.clusters?.sprites ?? []).map((id) => sprites.findIndex((sprite) => sprite.id === id)).filter((index) => index >= 0);
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
 * Nor does it touch anything in `taken`, the POIs' pictures and rewards.
 *
 * Each pick is any sprite of the sheet, all equally likely (Q59). A pick that
 * lands on one of the sheet's `clusters` sprites, a bush, brings a small
 * cluster round it instead of standing alone: [Andrei, 2026-09-26] "It may
 * make sense to put the bushes in small clusters." Q59 settles what one is:
 * `min` to `max` of those sprites, each after the first picked at random from
 * them so kinds mix, each touching one placed before it in a random direction
 * so they clump rather than line up, and every one counting towards the
 * terrain's density. A bush of a cluster that breaks a rule is left out, and
 * so is one no longer touching any other; a cluster left with fewer than two
 * is not placed at all.
 *
 * Last, all but `edgeTreesKept` of the trees past the outermost roads are
 * taken off and planted in the middle of the forest instead (710, 711).
 */
export function placeDressing(ground: Ground, taken: readonly Box[], edgeTreesKept = EDGE_TREES_KEPT): Billboard[] {
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
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  // Screen pixels across per unit of ground, so a picture's width on screen
  // gives the round footprint it stands on.
  const across = Math.hypot(projection.matrix.a, projection.matrix.c);

  /** The billboard for a standing sprite at `at`, or `null` where it would be in the way. */
  const stand = (at: Point, option: DressingArt, terrain: Terrain, sprite: SpriteRef): Billboard | null => {
    if (!inside(bounds, at)) return null;
    const nearest = nearestNode(map, at);
    if (nearest === null || nearest.terrain !== terrain) return null;
    if (nearest.distance < spacing * 0.3) return null;
    if (graph.edges.some((edge) => distanceToSegment(at, position(graph, edge.a), position(graph, edge.b)) < spacing * 0.14)) {
      return null;
    }
    const size = option.size * SPACING_PX;
    const foot = projection.toScreen(at);
    const shape = shapeOf(sprite);
    // The picture rises above its foot; a node or road inside it would be hidden.
    const box = grow(pictureBox(foot, size, shape), size * STANDING_MARGIN);
    if (obstacles.anyInBox(box.minX, box.minY, box.maxX, box.maxY)) return null;
    const bands = pictureBands(foot, size, shape).map((band) => grow(band, size * STANDING_MARGIN));
    if (taken.some((other) => overlapArea(box, other) > 0 && bands.some((band) => overlapArea(band, other) > 0))) return null;
    return { layer: 'dressing', sprite, foot, size, node: null, depth: foot.y };
  };

  /** How far a sprite's footprint reaches on the ground from its foot. */
  const footprint = (option: DressingArt, sprite: SpriteRef): number => {
    const shape = shapeOf(sprite);
    return ((shape.right - shape.left) * option.size * SPACING_PX) / 2 / across;
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

    const sprite = dressingSprite(catalog, option, pickSprite);
    const bushes = clusteredSprites(catalog, option);
    if (option.clusters === null || !bushes.includes(sprite.index)) {
      const item = stand(at, option, nearest.terrain, sprite);
      if (item === null) continue;
      placed.push(item);
      quota.set(nearest.terrain, left - 1);
      continue;
    }

    const { min, max } = option.clusters;
    const count = min + Math.floor(rng.nextFloat() * (max - min + 1));
    const members: { sprite: SpriteRef; spot: Point; reach: number }[] = [
      { sprite, spot: at, reach: footprint(option, sprite) },
    ];
    while (members.length < count) {
      const next: SpriteRef = { sheet: option.sheet, index: bushes[wrapIndex(rng.nextUint32(), bushes.length)] ?? sprite.index };
      const reach = footprint(option, next);
      let spot = at;
      for (let tries = 0; tries < CLUSTER_TRIES; tries++) {
        const beside = members[wrapIndex(rng.nextUint32(), members.length)];
        if (beside === undefined) break;
        const angle = rng.nextFloat() * 2 * Math.PI;
        const gap = (reach + beside.reach) * CLUSTER_TOUCH;
        spot = { x: beside.spot.x + Math.cos(angle) * gap, y: beside.spot.y + Math.sin(angle) * gap };
        // Not crowding any other bush more than it touches its neighbour.
        if (members.every((other) => distance(spot, other.spot) >= (reach + other.reach) * CLUSTER_TOUCH * 0.99)) break;
      }
      members.push({ sprite: next, spot, reach });
    }
    const kept = members.flatMap((member) => {
      const item = stand(member.spot, option, nearest.terrain, member.sprite);
      return item === null ? [] : [{ ...member, item }];
    });
    // A bush whose neighbours were all left out would stand apart from its
    // cluster, so it goes too.
    const joined = kept.filter((member) =>
      kept.some((other) => other !== member && distance(member.spot, other.spot) <= (member.reach + other.reach) * CLUSTER_TOUCH * 1.01),
    );
    if (joined.length < 2) continue;
    for (const { item } of joined) placed.push(item);
    quota.set(nearest.terrain, left - joined.length);
  }
  const kept = thinEdgeTrees(ground, placed, edgeTreesKept);

  // [Andrei, 2026-10-01] "I would rather ask you to fit more in the middle."
  // 711: the trees taken off the edge are planted in the middle of the forest
  // instead, by the same rules as every other tree, as many as fit. They come
  // from a stream of their own, so nothing placed above moves.
  const middle = createRng(map.seed).fork('middle trees');
  const trees = manifest.terrain.forest.dressing.filter((d) => d.layer === 'standing');
  const moved = placed.length - kept.length;
  let planted = 0;
  for (let attempt = 0; attempt < moved * MIDDLE_TRIES && planted < moved; attempt++) {
    const at = { x: bounds.min.x + middle.nextFloat() * width, y: bounds.min.y + middle.nextFloat() * height };
    const pickDressing = middle.nextFloat();
    const pickSprite = middle.nextUint32();
    if (nearestNode(map, at)?.terrain !== 'forest' || pastTheRoads(map, bounds, at)) continue;
    const option = pick(trees, pickDressing);
    if (option === undefined) continue;
    const item = stand(at, option, 'forest', dressingSprite(catalog, option, pickSprite));
    if (item === null) continue;
    kept.push(item);
    planted++;
  }
  return kept;
}

/**
 * [Andrei, 2026-10-01] "Trees are crowding too at the edge." Nothing stands
 * between the outermost roads and the ground's edge for a tree to keep clear
 * of, and along the back edges a tree hides nothing behind it, so that strip
 * took most of the forest's trees and stood them in a hedge. So the trees
 * past the outermost roads are taken off but for `kept` of them, each staying
 * by that chance (710: a third); every other tree, bush and stone stays where
 * it was.
 */
function thinEdgeTrees(ground: Ground, placed: Billboard[], kept: number): Billboard[] {
  const { map, projection, bounds } = ground;
  const rng = createRng(map.seed).fork('edge trees');
  return placed.filter((item) => {
    const at = projection.toWorld(item.foot);
    if (nearestNode(map, at)?.terrain !== 'forest' || !pastTheRoads(map, bounds, at)) return true;
    return rng.nextFloat() < kept;
  });
}

/** Whether the straight way from `at` to the nearest edge of the ground crosses no road. */
function pastTheRoads(map: GameMap, bounds: Bounds, at: Point): boolean {
  const graph = map.graph;
  const ways: Point[] = [
    { x: bounds.min.x, y: at.y },
    { x: bounds.max.x, y: at.y },
    { x: at.x, y: bounds.min.y },
    { x: at.x, y: bounds.max.y },
  ];
  const edge = ways.reduce((best, way) => (distance(at, way) < distance(at, best) ? way : best));
  return !graph.edges.some((road) => segmentsCross(at, edge, position(graph, road.a), position(graph, road.b)));
}

function segmentsCross(p: Point, q: Point, a: Point, b: Point): boolean {
  const side = (o: Point, s: Point, t: Point): number => Math.sign((s.x - o.x) * (t.y - o.y) - (s.y - o.y) * (t.x - o.x));
  return side(p, q, a) !== side(p, q, b) && side(a, b, p) !== side(a, b, q);
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
 * it. For this, mountains can be resized to fit the necessary space." And,
 * on the result: "we need to leave the mountains placed in the middle of the
 * mountain region large."
 *
 * So the largest go down first. Spots are sown over every backdrop terrain
 * on a jittered grid `BACKDROP_STEP` of the smallest size apart, then tried
 * at one size after another from the sheet's `size` down to its `min_size`:
 * a sprite stands wherever its silhouette lies wholly over its own terrain
 * and most of it is still bare ground. The middle of a region fills with
 * large mountains first, and smaller ones fill in round them and along the
 * edges, where a large one would not fit.
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
  const all = [...options.values()].flat();
  const smallest = Math.min(...all.map((d) => d.minSize));
  const step = smallest * spacing * BACKDROP_STEP;

  // Every spot, with the sheet and sprite it would draw.
  const spots: { at: Point; foot: Point; terrain: Terrain; option: DressingArt; sprite: SpriteRef; jitter: number }[] = [];
  for (let gy = bounds.min.y; gy < bounds.max.y; gy += step) {
    for (let gx = bounds.min.x; gx < bounds.max.x; gx += step) {
      const at = { x: gx + rng.nextFloat() * step, y: gy + rng.nextFloat() * step };
      const pickDressing = rng.nextFloat();
      const pickSprite = rng.nextUint32();
      const jitter = rng.nextFloat();
      if (!inside(bounds, at)) continue;
      const terrain = nearestNode(map, at)?.terrain;
      if (terrain === undefined || !terrains.has(terrain)) continue;
      const option = pick(options.get(terrain) ?? [], pickDressing);
      if (option === undefined) continue;
      const sprite = dressingSprite(catalog, option, pickSprite);
      spots.push({ at, foot: projection.toScreen(at), terrain, option, sprite, jitter });
    }
  }

  const over = (terrain: Terrain) => (screen: Point): boolean => {
    const at = projection.toWorld(screen);
    return inside(bounds, at) && nearestNode(map, at)?.terrain === terrain;
  };
  const placed: Billboard[] = [];
  const bodies: Box[] = [];
  const bare = (point: Point): boolean =>
    !bodies.some((body) => point.x >= body.minX && point.x <= body.maxX && point.y >= body.minY && point.y <= body.maxY);
  const taken = new Set<number>();

  // From the largest size down, each a step smaller than the last.
  const largest = Math.max(...all.map((d) => d.size));
  for (let tier = largest; tier >= smallest * 0.999; tier *= BACKDROP_SHRINK) {
    spots.forEach((spot, index) => {
      if (taken.has(index)) return;
      const { option } = spot;
      if (tier > option.size * 1.001 || tier < option.minSize * 0.999) return;
      // A little variety within a size, never below the sheet's smallest.
      const size = Math.max(option.minSize, tier * (0.9 + 0.1 * spot.jitter)) * SPACING_PX;
      const shape = shapeOf(spot.sprite);
      const outline = silhouettePoints(spot.foot, size, shape);
      if (!outline.every(over(spot.terrain))) return;
      if (outline.filter(bare).length < outline.length * BACKDROP_BARE) return;
      taken.add(index);
      placed.push({ layer: 'backdrop', sprite: spot.sprite, foot: spot.foot, size, node: null, depth: spot.foot.y });
      bodies.push(body(spot.foot, size, shape));
    });
  }
  return placed;
}

/** Each size tried is this share of the one before. */
export const BACKDROP_SHRINK = 0.8;

/** A new backdrop sprite needs at least this share of its outline over bare ground. */
export const BACKDROP_BARE = 0.5;

/** The solid middle of a backdrop picture: what a later one should not stand on. */
function body(foot: Point, size: number, shape: SpriteShape): Box {
  const box = pictureBox(foot, size, shape);
  const inset = (box.maxX - box.minX) * 0.15;
  return { minX: box.minX + inset, minY: box.minY + (box.maxY - box.minY) * 0.3, maxX: box.maxX - inset, maxY: box.maxY };
}
