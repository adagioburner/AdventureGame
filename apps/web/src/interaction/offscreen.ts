import type { PlayerId, Point } from '@adventure/core';
import type { Box } from '../render/placement.ts';

/**
 * [Andrei, 2026-10-26] "when i zoom on, i lose track of where other players
 * are. can we have small floaters with character figurines and arrows
 * floating near the edge of the screen and pointing in the direction of where
 * those players are".
 *
 * [Q320] Every player whose figure is wholly out of the map's box, the
 * player on turn too, at any zoom (3, 4), gets a marker just inside its edge,
 * where the line from the middle of the view to the figure leaves it, with an
 * arrow from the marker to the figure. The markers run round the map's
 * buttons rather than under them, and two that would overlap slide apart
 * along the edge (6). Andrei, 2026-10-26: "adjust the marker positions
 * slightly so they dont cover important things" (7): a marker that would
 * cover something in `avoid` slides along the edge, by at most `shift`, to
 * the nearest spot clear of it, and stays put when there is none.
 *
 * [Q327] Andrei, 2026-10-28: "when the map glides, it looks like the portrait
 * floaters keep adjusting, avoiding map features That makes them jumpy, and
 * is unnecessary. can we adjust them only once, when the gliding stops":
 * while the map glides each marker keeps the slide it had as the glide began
 * (`held`), still keeping apart from the others and round the map's buttons,
 * and slides off what it keeps off again once the map stops.
 *
 * Plain geometry in the map's box, in CSS pixels, so it is tested headlessly;
 * `MapView` draws the markers.
 */

export interface FigureOnScreen {
  readonly player: PlayerId;
  /** The box the figure's picture covers, in the map's box. */
  readonly box: Box;
}

export interface EdgeMarker {
  readonly player: PlayerId;
  /** The marker's middle, in the map's box. */
  readonly at: Point;
  /** Which way the arrow points, from the marker to the figure, in radians clockwise from the right. */
  readonly angle: number;
  /** How far along the edge it slid to keep off `avoid`, for the next frame's `previous`. */
  readonly shift: number;
  /**
   * [Q327] How far along the edge it sits from where the line to its figure
   * leaves the view, after sliding apart and off `avoid`, for the next frame's
   * `held`.
   */
  readonly slide: number;
}

export interface EdgeMarkerLayout {
  /** How far the markers' middles stay inside the map's box. */
  readonly inset: number;
  /** How far apart two markers' middles are at least. */
  readonly spacing: number;
  /** Boxes in a corner of the map's box that markers go round: the map's buttons. */
  readonly keepClear: readonly Box[];
  /** Half the width of the box a marker covers round its middle. */
  readonly radius: number;
  /** What a marker keeps off where it can, in the map's box. */
  readonly avoid: readonly Box[];
  /** How far along the edge a marker slides at most to keep off `avoid`. */
  readonly shift: number;
}

/** How finely a marker tries spots along the edge as it slides, in CSS pixels. */
const SHIFT_STEP_PX = 2;

/**
 * The markers for the figures out of view, in the order of `figures`.
 * `previous` is how far each slid last frame: a marker kept off something
 * stays on the same side of it while that spot is clear, rather than jumping
 * from side to side as the map moves. [Q327] While the map glides, `held` is
 * each marker's `slide` from the frame before the glide began: each keeps it,
 * a marker that came since has none, and none looks at `avoid`.
 */
export function edgeMarkers(
  viewport: Point,
  figures: readonly FigureOnScreen[],
  layout: EdgeMarkerLayout,
  previous: ReadonlyMap<PlayerId, number> = new Map(),
  held: ReadonlyMap<PlayerId, number> | null = null,
): EdgeMarker[] {
  const track = markerTrack(viewport, layout);
  if (track.length === 0) return [];
  const middle = { x: viewport.x / 2, y: viewport.y / 2 };
  const out = figures
    .filter((figure) => !overlaps(figure.box, viewport))
    .map((figure) => {
      const target = { x: (figure.box.minX + figure.box.maxX) / 2, y: (figure.box.minY + figure.box.maxY) / 2 };
      return { player: figure.player, target, along: alongTrack(track, castOnto(track, middle, target)) };
    });
  const total = perimeter(track);
  if (held !== null) {
    const spread = spreadAlong(
      out.map((one) => wrap(one.along + (held.get(one.player) ?? 0), total)),
      total,
      layout.spacing,
    );
    return out.map((one, index) => {
      const at = pointAlong(track, spread[index] ?? one.along);
      return { player: one.player, at, angle: Math.atan2(one.target.y - at.y, one.target.x - at.x), shift: previous.get(one.player) ?? 0, slide: held.get(one.player) ?? 0 };
    });
  }
  const spread = spreadAlong(
    out.map((one) => one.along),
    total,
    layout.spacing,
  );
  const placed = out.map((one, index) => pointAlong(track, spread[index] ?? one.along));
  return out.map((one, index) => {
    const along = spread[index] ?? one.along;
    const clearAt = (shift: number): boolean => {
      const at = pointAlong(track, along + shift);
      const covers = { minX: at.x - layout.radius, minY: at.y - layout.radius, maxX: at.x + layout.radius, maxY: at.y + layout.radius };
      return (
        !layout.avoid.some((box) => box.maxX > covers.minX && box.minX < covers.maxX && box.maxY > covers.minY && box.minY < covers.maxY) &&
        placed.every((other, otherIndex) => otherIndex === index || Math.hypot(other.x - at.x, other.y - at.y) >= layout.spacing - 1e-6)
      );
    };
    const last = previous.get(one.player);
    const tries = [0, ...(last !== undefined && last !== 0 && Math.abs(last) <= layout.shift ? [last] : [])];
    for (let step = SHIFT_STEP_PX; step <= layout.shift; step += SHIFT_STEP_PX) tries.push(-step, step);
    const shift = tries.find(clearAt) ?? 0;
    const at = pointAlong(track, along + shift);
    placed[index] = at;
    const slide = wrap(along + shift - one.along + total / 2, total) - total / 2;
    return { player: one.player, at, angle: Math.atan2(one.target.y - at.y, one.target.x - at.x), shift, slide };
  });
}

/** `along` brought round into a loop `total` long. */
function wrap(along: number, total: number): number {
  return ((along % total) + total) % total;
}

/** Whether `box` shows at all in a map's box `viewport` across. */
function overlaps(box: Box, viewport: Point): boolean {
  return box.maxX > 0 && box.minX < viewport.x && box.maxY > 0 && box.minY < viewport.y;
}

/**
 * The closed path the markers' middles run along, clockwise from the top
 * left: the map's box drawn in by `inset`, with a step round each box to keep
 * clear of that holds a corner. Empty when the box is too small for it.
 */
export function markerTrack(viewport: Point, layout: Pick<EdgeMarkerLayout, 'inset' | 'keepClear'>): Point[] {
  const { inset } = layout;
  const left = inset;
  const top = inset;
  const right = viewport.x - inset;
  const bottom = viewport.y - inset;
  if (right <= left || bottom <= top) return [];
  // Each corner, and how a box over it is stepped round: the corner's two
  // sides, as points along them, in the clockwise order the path meets them.
  const corners: { corner: Point; step(box: Box): Point[] | null }[] = [
    {
      corner: { x: left, y: top },
      step: (box) => (box.minX - inset <= left && box.minY - inset <= top ? [{ x: left, y: box.maxY + inset }, { x: box.maxX + inset, y: box.maxY + inset }, { x: box.maxX + inset, y: top }] : null),
    },
    {
      corner: { x: right, y: top },
      step: (box) => (box.maxX + inset >= right && box.minY - inset <= top ? [{ x: box.minX - inset, y: top }, { x: box.minX - inset, y: box.maxY + inset }, { x: right, y: box.maxY + inset }] : null),
    },
    {
      corner: { x: right, y: bottom },
      step: (box) => (box.maxX + inset >= right && box.maxY + inset >= bottom ? [{ x: right, y: box.minY - inset }, { x: box.minX - inset, y: box.minY - inset }, { x: box.minX - inset, y: bottom }] : null),
    },
    {
      corner: { x: left, y: bottom },
      step: (box) => (box.minX - inset <= left && box.maxY + inset >= bottom ? [{ x: box.maxX + inset, y: bottom }, { x: box.maxX + inset, y: box.minY - inset }, { x: left, y: box.minY - inset }] : null),
    },
  ];
  const path: Point[] = [];
  for (const { corner, step } of corners) {
    const stepped = layout.keepClear.map(step).find((points) => points !== null && points.every((point) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom));
    path.push(...(stepped ?? [corner]));
  }
  return path;
}

/** Where the line from `from` towards `to` first meets `track`; `from` must be inside it. */
function castOnto(track: readonly Point[], from: Point, to: Point): Point {
  const direction = { x: to.x - from.x, y: to.y - from.y };
  let nearest = Infinity;
  for (let index = 0; index < track.length; index++) {
    const a = track[index]!;
    const b = track[(index + 1) % track.length]!;
    const side = { x: b.x - a.x, y: b.y - a.y };
    const across = direction.x * side.y - direction.y * side.x;
    if (across === 0) continue;
    const gap = { x: a.x - from.x, y: a.y - from.y };
    const reach = (gap.x * side.y - gap.y * side.x) / across;
    const on = (gap.x * direction.y - gap.y * direction.x) / across;
    if (reach > 0 && on >= 0 && on <= 1 && reach < nearest) nearest = reach;
  }
  if (!Number.isFinite(nearest)) return track[0]!;
  return { x: from.x + direction.x * nearest, y: from.y + direction.y * nearest };
}

function sideLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function perimeter(track: readonly Point[]): number {
  return track.reduce((sum, point, index) => sum + sideLength(point, track[(index + 1) % track.length]!), 0);
}

/** How far round `track` from its first point `point`, which lies on it, is. */
function alongTrack(track: readonly Point[], point: Point): number {
  let walked = 0;
  let best = { distance: Infinity, along: 0 };
  for (let index = 0; index < track.length; index++) {
    const a = track[index]!;
    const b = track[(index + 1) % track.length]!;
    const length = sideLength(a, b);
    const share = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length)));
    const distance = Math.hypot(a.x + (b.x - a.x) * share - point.x, a.y + (b.y - a.y) * share - point.y);
    if (distance < best.distance) best = { distance, along: walked + share * length };
    walked += length;
  }
  return best.along;
}

/** The point `along` round `track` from its first point. */
function pointAlong(track: readonly Point[], along: number): Point {
  const total = perimeter(track);
  let left = ((along % total) + total) % total;
  for (let index = 0; index < track.length; index++) {
    const a = track[index]!;
    const b = track[(index + 1) % track.length]!;
    const length = sideLength(a, b);
    if (left <= length && length > 0) return { x: a.x + ((b.x - a.x) * left) / length, y: a.y + ((b.y - a.y) * left) / length };
    left -= length;
  }
  return track[0]!;
}

/**
 * `positions` round a loop `total` long, moved as little as it takes for any
 * two to be at least `spacing` apart: each run of markers too close together
 * spreads out evenly about the middle of where its markers wanted to be.
 */
export function spreadAlong(positions: readonly number[], total: number, spacing: number): number[] {
  const count = positions.length;
  if (count < 2) return [...positions];
  const gap = Math.min(spacing, total / count);
  const order = positions.map((along, index) => ({ along, index })).sort((a, b) => a.along - b.along);
  // Start the loop after its widest gap, so a run never straddles the cut.
  let cut = 0;
  let widest = -Infinity;
  for (let at = 0; at < count; at++) {
    const next = at + 1 < count ? order[at + 1]!.along : order[0]!.along + total;
    if (next - order[at]!.along > widest) {
      widest = next - order[at]!.along;
      cut = (at + 1) % count;
    }
  }
  const line = [...order.slice(cut), ...order.slice(0, cut).map((one) => ({ ...one, along: one.along + total }))];
  // Runs of markers that sit closer than `gap` merge until none overlaps the next.
  const runs: { first: number; count: number; middle: number }[] = [];
  for (let at = 0; at < line.length; at++) {
    runs.push({ first: at, count: 1, middle: line[at]!.along });
    for (;;) {
      const last = runs[runs.length - 1]!;
      const before = runs[runs.length - 2];
      if (before === undefined) break;
      const lastStart = last.middle - ((last.count - 1) * gap) / 2;
      const beforeEnd = before.middle + ((before.count - 1) * gap) / 2;
      if (lastStart - beforeEnd >= gap) break;
      const merged = before.count + last.count;
      runs.splice(runs.length - 2, 2, { first: before.first, count: merged, middle: (before.middle * before.count + last.middle * last.count) / merged });
    }
  }
  const out = new Array<number>(count);
  for (const run of runs) {
    for (let k = 0; k < run.count; k++) {
      const one = line[run.first + k]!;
      out[one.index] = (((run.middle + (k - (run.count - 1) / 2) * gap) % total) + total) % total;
    }
  }
  return out;
}
