import type { NodeId, Point } from '@adventure/core';
import type { SpriteRef } from '../art/catalog.ts';

/**
 * Where a POI's picture stands, so that it hides as little of the game as it
 * can: no road, no other node, no other POI's picture or reward.
 *
 * Everything here is in screen pixels at zoom 1, because covering is a thing
 * that happens on screen: a building covers whatever lies above its foot, not
 * whatever lies near it on the map.
 */

/**
 * A box relative to a sprite's foot, in units of its sheet's typical span.
 * `x` grows to the right and `y` down the screen, so `top` is negative.
 */
export interface Extent {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * A sprite's solid picture — its keyed shadow left out — as its box and,
 * once its pixels are measured, band by band from top to bottom: where the
 * picture really is, so a picture can stand right up against its node rather
 * than wherever its box's empty corner allows. Without `bands` the box is the
 * picture.
 */
export interface SpriteShape extends Extent {
  readonly bands?: readonly Extent[];
}

/** How many horizontal bands a measured sprite's picture is cut into. */
export const SHAPE_BANDS = 12;

export type ShapeOf = (sprite: SpriteRef) => SpriteShape;

/**
 * A sprite's shape before its pixels are loaded (in the tests, say): as wide
 * as its typical span, four fifths as tall, standing on its foot. The browser
 * measures every sprite and passes the real shapes instead.
 */
export const ROUGH_SHAPE: ShapeOf = () => ({ left: -0.5, top: -0.8, right: 0.5, bottom: 0 });

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The screen box a sprite's picture covers when it stands at `foot`, `size` pixels across its typical span. */
export function pictureBox(foot: Point, size: number, shape: Extent): Box {
  return {
    minX: foot.x + shape.left * size,
    minY: foot.y + shape.top * size,
    maxX: foot.x + shape.right * size,
    maxY: foot.y + shape.bottom * size,
  };
}

/** The screen boxes a sprite's picture covers band by band; its one box when it has no bands. */
export function pictureBands(foot: Point, size: number, shape: SpriteShape): Box[] {
  const bands = shape.bands;
  if (bands === undefined || bands.length === 0) return [pictureBox(foot, size, shape)];
  return bands.map((band) => pictureBox(foot, size, band));
}

/** The smallest box holding every one of `boxes`. */
export function boundsOf(boxes: readonly Box[]): Box {
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
  };
}

/** How much two pictures, each a set of bands, share. */
export function overlapBands(p: readonly Box[], q: readonly Box[]): number {
  let shared = 0;
  for (const a of p) for (const b of q) shared += overlapArea(a, b);
  return shared;
}

export function grow(box: Box, by: number): Box {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

export function overlapArea(p: Box, q: Box): number {
  const width = Math.min(p.maxX, q.maxX) - Math.max(p.minX, q.minX);
  const height = Math.min(p.maxY, q.maxY) - Math.max(p.minY, q.minY);
  return width > 0 && height > 0 ? width * height : 0;
}

function area(box: Box): number {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function areaOf(boxes: readonly Box[]): number {
  return boxes.reduce((sum, box) => sum + area(box), 0);
}

/** A node's oval on screen: its centre and its two semi-axes, outline included. */
export interface Oval {
  readonly at: Point;
  readonly rx: number;
  readonly ry: number;
}

/** Whether a box and an oval share any point. */
export function boxTouchesOval(box: Box, oval: Oval): boolean {
  const x = Math.min(Math.max(oval.at.x, box.minX), box.maxX);
  const y = Math.min(Math.max(oval.at.y, box.minY), box.maxY);
  return ((x - oval.at.x) / oval.rx) ** 2 + ((y - oval.at.y) / oval.ry) ** 2 <= 1;
}

/** How much of the segment from `a` to `b` lies inside the box (Liang–Barsky). */
export function lengthInBox(a: Point, b: Point, box: Box): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    clip(-dx, a.x - box.minX) &&
    clip(dx, box.maxX - a.x) &&
    clip(-dy, a.y - box.minY) &&
    clip(dy, box.maxY - a.y)
  ) {
    return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
  }
  return 0;
}

export interface PoiPicture {
  readonly node: NodeId;
  /** Its node's oval. */
  readonly oval: Oval;
  readonly sprite: SpriteRef;
  /** Screen pixels at zoom 1 across the sheet's typical span. */
  readonly size: number;
  /** Stands on its node, its base across the node, rather than beside it: the guardians. */
  readonly onNode: boolean;
}

export interface Surroundings {
  /** Every road, as a screen segment. */
  readonly roads: readonly (readonly [Point, Point])[];
  /** Every node's oval, and whether it is a POI's. */
  readonly nodes: readonly (Oval & { readonly node: NodeId; readonly poi: boolean })[];
  /** Every POI's reward icons and guard number. */
  readonly labels: readonly Box[];
  /** Where the map's ground ends on screen: a picture's base should stay on it. */
  readonly onGround: (screen: Point) => boolean;
}

/**
 * Directions a picture may stand in from its node, in degrees counted
 * anticlockwise from screen-right, best first. Straight behind is first, so
 * a picture with nothing to avoid stands behind its node as it always did;
 * nothing faces the viewer, where the node's own icons and number go.
 */
export const PICTURE_DIRECTIONS: readonly number[] = [90, 60, 120, 30, 150, 0, 180];

/**
 * How far from its node's centre a guardian stands, as a share of the way to
 * the rim of the node's oval: on the node with its base across it, but never
 * in the middle of it, where it would hide the whole node.
 */
export const ON_NODE_REACH = 0.6;

/**
 * What a guardian pays, in rough pixels of road, for stepping off its node to
 * stand beside it instead: more than the road its legs hide, less than
 * covering a neighbour's node or picture, which is the only reason to step
 * off.
 */
export const OFF_NODE = 60;

/** How many times every picture is reconsidered once all of them stand somewhere. */
const ROUNDS = 3;

/**
 * What any overlap with another POI's picture costs, however small, in rough
 * pixels of road: as much as covering a plain node. Without it a corner's
 * overlap cost next to nothing, and once the guards were drawn twice the size
 * (Andrei, 2026-09-23) a crowded mountain ended with pictures touching and one
 * guard standing over another POI's node, to save a little road elsewhere.
 */
const PICTURE_OVERLAP = 40;

/**
 * [Andrei, review 2026-09-23] "can you try placing the POI images so that
 * they do not obscure roads and other POI"; and later that day, "let us place
 * POI images closer to the POIs themselves, close to or touching the node.
 * Guards, specifically, can be standing on the node itself, not centered on
 * it but intersecting at the base".
 *
 * Every picture stands in one of `PICTURE_DIRECTIONS` from its own node.
 * Most stand beside it, their picture, band by band, touching the node's oval
 * but nowhere over it, so no empty corner of their box keeps them away. A
 * guardian stands on the node instead, its foot `ON_NODE_REACH` of the way
 * from the centre to the rim, and steps off to stand beside it like the rest
 * only where every spot on it would cover a neighbour (`OFF_NODE`). Each
 * picture takes the spot that hides least: road length first, then other
 * nodes, other POIs' pictures and other POIs' rewards, each weighed by how
 * much it matters to a player. Pictures start at their first spot and each
 * is then moved in turn to its best given where the others stand, a few
 * rounds over, in map order, so the same map always comes out the same.
 */
export function placePoiPictures(pictures: readonly PoiPicture[], around: Surroundings, shapeOf: ShapeOf): Point[] {
  const spots = pictures.map((picture) => spotsFor(picture, shapeOf(picture.sprite)));
  const feet = spots.map((options) => options.map((spot) => spot.foot));
  const bands = pictures.map((picture, index) =>
    (feet[index] ?? []).map((foot) => pictureBands(foot, picture.size, shapeOf(picture.sprite))),
  );
  const boxes = bands.map((options) => options.map(boundsOf));
  const choice = pictures.map(() => 0);

  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    pictures.forEach((picture, index) => {
      let best = choice[index] ?? 0;
      let bestCost = Infinity;
      spots[index]?.forEach((spot, option) => {
        const mine = bands[index]?.[option] ?? [];
        const box = boxes[index]?.[option] as Box;
        let cost = spot.bias + hidden(mine, picture, around);
        // Another POI's picture, as it stands now; their nodes are counted
        // with the rest of the nodes.
        pictures.forEach((_, at) => {
          if (at === index) return;
          const theirs = choice[at] ?? 0;
          if (overlapArea(box, boxes[at]?.[theirs] as Box) === 0) return;
          const other = bands[at]?.[theirs] ?? [];
          const shared = overlapBands(mine, other);
          if (shared > 0) cost += PICTURE_OVERLAP + (150 * shared) / Math.max(1, Math.min(areaOf(mine), areaOf(other)));
        });
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          best = option;
        }
      });
      if (best !== choice[index]) moved = true;
      choice[index] = best;
    });
    if (!moved) break;
  }
  return pictures.map((_, index) => feet[index]?.[choice[index] ?? 0] as Point);
}

/** What a picture standing in `bands` hides of the map, in rough pixels of road. */
export function hidden(bands: readonly Box[], picture: PoiPicture, around: Surroundings): number {
  const box = boundsOf(bands);
  let cost = 0;
  for (const [a, b] of around.roads) {
    if (lengthInBox(a, b, box) === 0) continue;
    for (const band of bands) cost += lengthInBox(a, b, band);
  }
  for (const node of around.nodes) {
    if (node.node === picture.node || !bands.some((band) => boxTouchesOval(band, node))) continue;
    cost += node.poi ? 120 : 40;
  }
  // A reward drawn over a picture hides the picture as much as the picture
  // would hide the reward, so this counts whichever is the larger share.
  for (const label of around.labels) {
    const shared = overlapBands(bands, [label]);
    if (shared > 0) cost += (120 * shared) / Math.max(1, Math.min(areaOf(bands), area(label)));
  }
  const base = [
    { x: box.minX, y: box.maxY },
    { x: (box.minX + box.maxX) / 2, y: box.maxY },
    { x: box.maxX, y: box.maxY },
  ];
  for (const point of base) if (!around.onGround(point)) cost += 30;
  return cost;
}

/**
 * Where a picture may stand, best first, each with what choosing it costs
 * before anything it hides: a little for each direction further from
 * straight behind, and `OFF_NODE` for a guardian stepping off its node.
 */
export function spotsFor(picture: PoiPicture, shape: SpriteShape): { foot: Point; bias: number }[] {
  const beside = PICTURE_DIRECTIONS.map((angle, index) => ({ foot: footTouching(picture, angle, shape), bias: index * 2 }));
  if (!picture.onNode) return beside;
  const on = PICTURE_DIRECTIONS.map((angle, index) => ({ foot: footOnNode(picture.oval, angle), bias: index * 2 }));
  return [...on, ...beside.map((spot) => ({ ...spot, bias: spot.bias + OFF_NODE }))];
}

/** A guardian's foot: on its node's oval, `ON_NODE_REACH` of the way from the centre to the rim in direction `angle`. */
export function footOnNode(oval: Oval, angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  return {
    x: oval.at.x + Math.cos(radians) * oval.rx * ON_NODE_REACH,
    y: oval.at.y - Math.sin(radians) * oval.ry * ON_NODE_REACH,
  };
}

/**
 * The foot that puts the picture next to its node in direction `angle`: its
 * picture, band by band, as close to the node as it goes without covering
 * any of the node's oval.
 */
export function footTouching(picture: PoiPicture, angle: number, shape: SpriteShape): Point {
  const { oval, size } = picture;
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = -Math.sin(radians);
  // The picture's box centre moves out from the node's centre along the
  // direction; this is where its foot is then.
  const centre = { x: ((shape.left + shape.right) / 2) * size, y: ((shape.top + shape.bottom) / 2) * size };
  const footAt = (t: number): Point => ({ x: oval.at.x + dx * t - centre.x, y: oval.at.y + dy * t - centre.y });
  const touches = (t: number): boolean => pictureBands(footAt(t), size, shape).some((band) => boxTouchesOval(band, oval));
  // In from far enough out that it is clear, a step at a time, to the first
  // place it touches — a picture with a gap in it may be clear again closer
  // in, even centred on the node — then a bisection between the two.
  const far = ((shape.right - shape.left + shape.bottom - shape.top) * size) / 2 + oval.rx + oval.ry;
  const step = far / 64;
  let clear = far;
  while (clear > step && !touches(clear - step)) clear -= step;
  let touching = Math.max(0, clear - step);
  for (let i = 0; i < 20; i++) {
    const mid = (touching + clear) / 2;
    if (touches(mid)) touching = mid;
    else clear = mid;
  }
  return footAt(clear);
}
