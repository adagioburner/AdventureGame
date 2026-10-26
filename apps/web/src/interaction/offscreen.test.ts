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
