import { describe, expect, it } from 'vitest';
import { asPlayerId } from '@adventure/core';
import { edgeMarkers, markerTrack, spreadAlong } from './offscreen.ts';

const viewport = { x: 800, y: 600 };
const layout = { inset: 40, spacing: 56, keepClear: [], radius: 28, avoid: [], shift: 48 };
const at = (player: string, x: number, y: number) => ({ player: asPlayerId(player), box: { minX: x - 10, minY: y - 30, maxX: x + 10, maxY: y } });

describe('edgeMarkers', () => {
  it('gives no marker to a figure that shows, even in part', () => {
    expect(edgeMarkers(viewport, [at('a', 400, 300), at('b', 805, 300), at('c', 400, 620)], layout)).toEqual([]);
  });

  it('puts the marker where the line from the middle to the figure leaves the view, pointing at the figure', () => {
    const [right] = edgeMarkers(viewport, [at('a', 2000, 285)], layout);
    expect(right?.at.x).toBeCloseTo(760);
    expect(right?.at.y).toBeCloseTo(300 - (30 * 360) / 1600);
    expect(right?.angle).toBeCloseTo(Math.atan2(285 - 15 - (right?.at.y ?? 0), 2000 - 760), 5);
    const [up] = edgeMarkers(viewport, [at('b', 400, -500)], layout);
    expect(up?.at).toEqual({ x: 400, y: 40 });
    expect(up?.angle).toBeCloseTo(-Math.PI / 2);
  });

  it('pushes apart two markers that would overlap', () => {
    const markers = edgeMarkers(viewport, [at('a', 390, 2000), at('b', 410, 2000)], layout);
    expect(markers).toHaveLength(2);
    const [a, b] = markers;
    expect(Math.abs((a?.at.x ?? 0) - (b?.at.x ?? 0))).toBeCloseTo(56);
    expect(a?.at.y).toBeCloseTo(560);
    expect(a?.at.x).toBeLessThan(b?.at.x ?? 0);
  });

  it('goes round the map buttons in the bottom right corner', () => {
    const buttons = { minX: 680, minY: 360, maxX: 784, maxY: 584 };
    const [marker] = edgeMarkers(viewport, [at('a', 2000, 1500)], { ...layout, keepClear: [buttons] });
    expect(marker).toBeDefined();
    const x = marker?.at.x ?? 0;
    const y = marker?.at.y ?? 0;
    expect(x <= buttons.minX - 40 + 1e-6 || y <= buttons.minY - 40 + 1e-6).toBe(true);
  });
});

describe('edgeMarkers keeping off what matters', () => {
  // A figure straight below the middle: its marker wants to sit at (400, 560).
  const below = at('a', 400, 2000);
  const thing = (minX: number, maxX: number) => ({ minX, minY: 540, maxX, maxY: 580 });

  it('stays where it is when nothing is under it', () => {
    const [marker] = edgeMarkers(viewport, [below], { ...layout, avoid: [thing(100, 200)] });
    expect(marker?.at).toEqual({ x: 400, y: 560 });
    expect(marker?.shift).toBe(0);
  });

  it('slides along the edge to the nearest spot clear of it', () => {
    // Clear of 380 to 410 means a middle at 352 or less, or 438 or more: 438 is nearer.
    const [marker] = edgeMarkers(viewport, [below], { ...layout, avoid: [thing(380, 410)] });
    expect(marker?.at.y).toBeCloseTo(560);
    expect(marker?.at.x).toBeCloseTo(438);
    expect(Math.abs(marker?.shift ?? 0)).toBeCloseTo(38);
  });

  it('stays put when no spot within the slide is clear', () => {
    const [marker] = edgeMarkers(viewport, [below], { ...layout, avoid: [thing(300, 500)] });
    expect(marker?.at).toEqual({ x: 400, y: 560 });
    expect(marker?.shift).toBe(0);
  });

  it('keeps to the side it slid to last time while that spot is clear', () => {
    const avoid = [thing(380, 410)];
    const [first] = edgeMarkers(viewport, [below], { ...layout, avoid });
    const otherSide = -Math.sign(first?.shift ?? 0) * 48;
    const [next] = edgeMarkers(viewport, [below], { ...layout, avoid }, new Map([[below.player, otherSide]]));
    expect(next?.at.x).toBeCloseTo(352);
    expect(next?.shift).toBe(otherSide);
  });

  it('does not slide onto another marker', () => {
    // Clear of 390 to 420 is nearer on the left, at 362, but b's marker sits at 340.
    const markers = edgeMarkers(viewport, [below, at('b', 400 - (60 * 1685) / 260, 2000)], { ...layout, spacing: 30, avoid: [thing(390, 420)] });
    expect(markers[1]?.at.x).toBeCloseTo(340);
    expect(markers[0]?.at.x).toBeCloseTo(448);
  });
});

describe('edgeMarkers while the map glides', () => {
  // A figure straight below the middle: its marker wants to sit at (400, 560).
  const below = at('a', 400, 2000);
  const thing = (minX: number, maxX: number) => ({ minX, minY: 540, maxX, maxY: 580 });
  // Where a figure at the bottom of the plane puts its marker's middle on the bottom edge.
  const under = (x: number) => 400 + ((x - 400) * 1685) / 260;

  it('keeps the slide it had as the glide began, over whatever comes under it, and slides off again once it stops', () => {
    const [before] = edgeMarkers(viewport, [below], { ...layout, avoid: [thing(380, 410)] });
    expect(before?.at.x).toBeCloseTo(438);
    expect(before?.slide).toBeCloseTo(before?.shift ?? 0);
    const previous = new Map([[below.player, before?.shift ?? 0]]);
    const held = new Map([[below.player, before?.slide ?? 0]]);
    const moved = at('a', under(420), 2000);
    const avoid = [thing(440, 470)];
    const [gliding] = edgeMarkers(viewport, [moved], { ...layout, avoid }, previous, held);
    expect(gliding?.at.x).toBeCloseTo(458);
    expect(gliding?.at.y).toBeCloseTo(560);
    expect(gliding?.shift).toBe(before?.shift);
    expect(gliding?.slide).toBe(before?.slide);
    const [stopped] = edgeMarkers(viewport, [moved], { ...layout, avoid }, previous);
    // Clear of 440 to 470 means a middle at 412 or less.
    expect(stopped?.at.x).toBeCloseTo(412);
  });

  it('sits where it sat on the frame before the glide', () => {
    const figures = [at('a', 390, 2000), at('b', 410, 2000), at('c', 2000, 285)];
    const settled = { ...layout, avoid: [thing(330, 360), { minX: 740, minY: 250, maxX: 780, maxY: 300 }] };
    const before = edgeMarkers(viewport, figures, settled);
    const gliding = edgeMarkers(viewport, figures, layout, new Map(before.map((one) => [one.player, one.shift])), new Map(before.map((one) => [one.player, one.slide])));
    expect(before.some((one) => one.slide !== 0)).toBe(true);
    gliding.forEach((one, index) => {
      expect(one.at.x).toBeCloseTo(before[index]?.at.x ?? 0);
      expect(one.at.y).toBeCloseTo(before[index]?.at.y ?? 0);
    });
  });

  it('puts a marker that came during the glide where the line to its figure leaves the view', () => {
    const [marker] = edgeMarkers(viewport, [below], { ...layout, avoid: [thing(380, 410)] }, new Map(), new Map());
    expect(marker?.at.x).toBeCloseTo(400);
    expect(marker?.slide).toBe(0);
  });

  it('still keeps apart from the other markers', () => {
    const b = at('b', 400, 2000);
    const markers = edgeMarkers(viewport, [below, b], layout, new Map(), new Map([[b.player, -20]]));
    expect(Math.abs((markers[0]?.at.x ?? 0) - (markers[1]?.at.x ?? 0))).toBeCloseTo(56);
    expect(markers[0]?.at.x).toBeCloseTo(382);
    expect(markers[1]?.at.x).toBeCloseTo(438);
  });
});

describe('markerTrack', () => {
  it('is the view drawn in by the inset', () => {
    expect(markerTrack(viewport, layout)).toEqual([
      { x: 40, y: 40 },
      { x: 760, y: 40 },
      { x: 760, y: 560 },
      { x: 40, y: 560 },
    ]);
  });

  it('steps round a box in a corner', () => {
    expect(markerTrack(viewport, { inset: 40, keepClear: [{ minX: 680, minY: 360, maxX: 784, maxY: 584 }] })).toEqual([
      { x: 40, y: 40 },
      { x: 760, y: 40 },
      { x: 760, y: 320 },
      { x: 640, y: 320 },
      { x: 640, y: 560 },
      { x: 40, y: 560 },
    ]);
  });

  it('is empty when the view is too small for markers', () => {
    expect(markerTrack({ x: 60, y: 600 }, layout)).toEqual([]);
  });
});

describe('spreadAlong', () => {
  it('leaves markers far enough apart where they are', () => {
    expect(spreadAlong([10, 100, 300], 1000, 50)).toEqual([10, 100, 300]);
  });

  it('spreads a run evenly about the middle of where it wanted to be', () => {
    expect(spreadAlong([100, 110, 120], 1000, 50)).toEqual([60, 110, 160]);
  });

  it('keeps each marker on its own spot in the run, in the order they wanted', () => {
    expect(spreadAlong([120, 100], 1000, 50)).toEqual([135, 85]);
  });

  it('spreads a run across the start of the loop', () => {
    const [a, b] = spreadAlong([990, 10], 1000, 50);
    expect(a).toBeCloseTo(975);
    expect(b).toBeCloseTo(25);
  });
});
