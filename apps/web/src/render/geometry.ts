import type { MapGraph, Point } from '@adventure/core';
import type { Bounds } from './isometric.ts';

/**
 * Plane geometry the scene needs and the engine does not: how long a typical
 * road is, what area each node's terrain covers, and how close a point is to a
 * road. All of it is derived from node positions and edges alone.
 */

/**
 * The median road length, in world units. Every size in `Art/manifest.json` is
 * a multiple of it, so the art is sized against the map's own scale and not
 * against `MAP_COORDINATE_SPACE`, which §1.3 says has none.
 */
export function nodeSpacing(graph: MapGraph): number {
  const lengths = graph.edges
    .map((edge) => distance(position(graph, edge.a), position(graph, edge.b)))
    .sort((p, q) => p - q);
  const middle = lengths[Math.floor(lengths.length / 2)];
  if (middle === undefined || middle <= 0) throw new RangeError('a map needs at least one edge of non-zero length');
  return middle;
}

/** The nodes' bounding box, grown by `margin` on every side. */
export function nodeBounds(graph: MapGraph, margin: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of graph.nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x);
    maxY = Math.max(maxY, node.position.y);
  }
  return { min: { x: minX - margin, y: minY - margin }, max: { x: maxX + margin, y: maxY + margin } };
}

export function position(graph: MapGraph, node: number): Point {
  const found = graph.nodes[node];
  if (found === undefined) throw new RangeError(`no node ${node}`);
  return found.position;
}

export function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSquared));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/**
 * Each node's Voronoi cell, clipped to `bounds`: the patch of ground that takes
 * that node's terrain. Every point inside `bounds` lies in the cell of its
 * nearest node, so the cells tile the map with no gap and no overlap, and a
 * terrain's region is simply the union of its nodes' cells.
 *
 * Half-plane clipping, one bisector per other node. At ~240 nodes that is a
 * few hundred thousand cheap operations once per map, and it needs no library.
 */
export function voronoiCells(points: readonly Point[], bounds: Bounds): Point[][] {
  return points.map((site, index) => {
    let cell: Point[] = [
      bounds.min,
      { x: bounds.max.x, y: bounds.min.y },
      bounds.max,
      { x: bounds.min.x, y: bounds.max.y },
    ];
    // Nearest first, so the cell shrinks quickly and later clips are cheap.
    const others = points
      .map((other, j) => ({ other, j, d: distance(site, other) }))
      .filter(({ j }) => j !== index)
      .sort((p, q) => p.d - q.d);
    for (const { other, d } of others) {
      // A site further than twice the cell's farthest corner cannot clip it.
      const reach = Math.max(...cell.map((corner) => distance(site, corner)));
      if (d > 2 * reach) break;
      cell = clipToCloserHalf(cell, site, other);
      if (cell.length === 0) break;
    }
    return cell;
  });
}

/** Keep the part of `polygon` closer to `site` than to `other` (Sutherland–Hodgman). */
function clipToCloserHalf(polygon: readonly Point[], site: Point, other: Point): Point[] {
  const nx = other.x - site.x;
  const ny = other.y - site.y;
  const mid = { x: (site.x + other.x) / 2, y: (site.y + other.y) / 2 };
  const side = (p: Point): number => (p.x - mid.x) * nx + (p.y - mid.y) * ny; // ≤ 0 keeps
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i] as Point;
    const next = polygon[(i + 1) % polygon.length] as Point;
    const sc = side(current);
    const sn = side(next);
    if (sc <= 0) out.push(current);
    if ((sc < 0 && sn > 0) || (sc > 0 && sn < 0)) {
      const t = sc / (sc - sn);
      out.push({ x: current.x + (next.x - current.x) * t, y: current.y + (next.y - current.y) * t });
    }
  }
  return out;
}

export function polygonArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i] as Point;
    const q = polygon[(i + 1) % polygon.length] as Point;
    twice += p.x * q.y - q.x * p.y;
  }
  return Math.abs(twice) / 2;
}

/** Whether segment `a`–`b` touches the axis-aligned box (Liang–Barsky clipping). */
export function segmentTouchesBox(a: Point, b: Point, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  for (const [p, q] of [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dy, a.y - minY],
    [dy, maxY - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

/**
 * A uniform grid over the screen for "would a box here cover anything"
 * questions, so dressing placement does not test every candidate against
 * every node and road. Points are nodes; segments are roads, tested exactly
 * rather than sampled, so a road cannot slip between samples.
 */
export class ObstacleGrid {
  private readonly points = new Map<string, Point[]>();
  private readonly segments = new Map<string, [Point, Point][]>();

  constructor(private readonly cellSize: number) {}

  addPoint(point: Point): void {
    push(this.points, this.key(this.cell(point.x), this.cell(point.y)), point);
  }

  addSegment(a: Point, b: Point): void {
    for (let gx = this.cell(Math.min(a.x, b.x)); gx <= this.cell(Math.max(a.x, b.x)); gx++) {
      for (let gy = this.cell(Math.min(a.y, b.y)); gy <= this.cell(Math.max(a.y, b.y)); gy++) {
        if (segmentTouchesBox(a, b, gx * this.cellSize, gy * this.cellSize, (gx + 1) * this.cellSize, (gy + 1) * this.cellSize)) {
          push(this.segments, this.key(gx, gy), [a, b]);
        }
      }
    }
  }

  /** Whether any point or segment touches the axis-aligned box. */
  anyInBox(minX: number, minY: number, maxX: number, maxY: number): boolean {
    for (let gx = this.cell(minX); gx <= this.cell(maxX); gx++) {
      for (let gy = this.cell(minY); gy <= this.cell(maxY); gy++) {
        const key = this.key(gx, gy);
        for (const p of this.points.get(key) ?? []) {
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) return true;
        }
        for (const [a, b] of this.segments.get(key) ?? []) {
          if (segmentTouchesBox(a, b, minX, minY, maxX, maxY)) return true;
        }
      }
    }
    return false;
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private key(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}
