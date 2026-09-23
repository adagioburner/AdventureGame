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
 * A sprite's solid picture — its keyed shadow left out — relative to its
 * foot, in units of its sheet's typical span. `x` grows to the right and `y`
 * down the screen, so `top` is negative.
 */
export interface SpriteShape {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

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
export function pictureBox(foot: Point, size: number, shape: SpriteShape): Box {
  return {
    minX: foot.x + shape.left * size,
    minY: foot.y + shape.top * size,
    maxX: foot.x + shape.right * size,
    maxY: foot.y + shape.bottom * size,
  };
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
 * they do not obscure roads and other POI".
 *
 * Every picture stands touching its own node — never on it — in one of
 * `PICTURE_DIRECTIONS`, and takes the direction that hides least: road
 * length first, then other nodes, other POIs' pictures and other POIs'
 * rewards, each weighed by how much it matters to a player. Pictures start
 * behind their nodes and each is then moved in turn to its best direction
 * given where the others stand, a few rounds over, in map order, so the same
 * map always comes out the same.
 */
export function placePoiPictures(pictures: readonly PoiPicture[], around: Surroundings, shapeOf: ShapeOf): Point[] {
  const candidates = pictures.map((picture) =>
    PICTURE_DIRECTIONS.map((angle) => footTouching(picture, angle, shapeOf(picture.sprite))),
  );
  const choice = pictures.map(() => 0);
  const boxOf = (index: number, option: number): Box => {
    const picture = pictures[index] as PoiPicture;
    const foot = candidates[index]?.[option] as Point;
    return pictureBox(foot, picture.size, shapeOf(picture.sprite));
  };

  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    pictures.forEach((picture, index) => {
      let best = choice[index] ?? 0;
      let bestCost = Infinity;
      PICTURE_DIRECTIONS.forEach((_, option) => {
        const box = boxOf(index, option);
        let cost = option * 2 + hidden(box, picture, around);
        // Another POI's picture, as it stands now; their nodes are counted
        // with the rest of the nodes.
        pictures.forEach((_, at) => {
          if (at === index) return;
          const theirs = boxOf(at, choice[at] ?? 0);
          const shared = overlapArea(box, theirs);
          if (shared > 0) cost += PICTURE_OVERLAP + (150 * shared) / Math.max(1, Math.min(area(box), area(theirs)));
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
  return pictures.map((_, index) => candidates[index]?.[choice[index] ?? 0] as Point);
}

/** What a picture standing in `box` hides of the map, in rough pixels of road. */
export function hidden(box: Box, picture: PoiPicture, around: Surroundings): number {
  let cost = 0;
  for (const [a, b] of around.roads) cost += lengthInBox(a, b, box);
  for (const node of around.nodes) {
    if (node.node === picture.node || !boxTouchesOval(box, node)) continue;
    cost += node.poi ? 120 : 40;
  }
  // A reward drawn over a picture hides the picture as much as the picture
  // would hide the reward, so this counts whichever is the larger share.
  for (const label of around.labels) {
    const shared = overlapArea(box, label);
    if (shared > 0) cost += (120 * shared) / Math.max(1, Math.min(area(box), area(label)));
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
 * The foot that puts the picture next to its node in direction `angle`: its
 * box as close to the node as it goes without covering the node's oval.
 */
export function footTouching(picture: PoiPicture, angle: number, shape: SpriteShape): Point {
  const { oval, size } = picture;
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = -Math.sin(radians);
  const half = { x: ((shape.right - shape.left) * size) / 2, y: ((shape.bottom - shape.top) * size) / 2 };
  const centreOffset = { x: ((shape.left + shape.right) / 2) * size, y: ((shape.top + shape.bottom) / 2) * size };
  const boxAt = (t: number): Box => {
    const cx = oval.at.x + dx * t;
    const cy = oval.at.y + dy * t;
    return { minX: cx - half.x, minY: cy - half.y, maxX: cx + half.x, maxY: cy + half.y };
  };
  // The box's centre moves out along the direction until the box clears the
  // oval: a bisection between touching and clear.
  let lo = 0;
  let hi = half.x + half.y + oval.rx + oval.ry;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (boxTouchesOval(boxAt(mid), oval)) lo = mid;
    else hi = mid;
  }
  const box = boxAt(hi);
  return { x: (box.minX + box.maxX) / 2 - centreOffset.x, y: (box.minY + box.maxY) / 2 - centreOffset.y };
}
