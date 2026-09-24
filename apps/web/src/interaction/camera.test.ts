import { describe, expect, it } from 'vitest';
import { createCameraController, followInto, glideCenter } from './camera.ts';

const fit = { zoom: 0.5, center: { x: 0, y: 0 } };
const viewport = { x: 800, y: 600 };

describe('lookAt', () => {
  it('moves the middle of the view and keeps the zoom it had', () => {
    const camera = createCameraController(fit, viewport);
    camera.zoomIn();
    const zoom = camera.camera.zoom;
    camera.lookAt({ x: 120, y: -40 });
    expect(camera.camera).toEqual({ zoom, center: { x: 120, y: -40 } });
  });

  it('stays on the whole-map zoom when that is where the view is', () => {
    const camera = createCameraController(fit, viewport);
    camera.lookAt({ x: 10, y: 20 });
    expect(camera.camera.zoom).toBe(fit.zoom);
  });
});

describe('glideCenter', () => {
  const from = { x: 0, y: 100 };
  const to = { x: 200, y: -100 };

  it('starts where the view is and ends on the figure', () => {
    expect(glideCenter(from, to, 0)).toEqual(from);
    expect(glideCenter(from, to, 1)).toEqual(to);
  });

  it('holds at either end outside 0 to 1', () => {
    expect(glideCenter(from, to, -0.5)).toEqual(from);
    expect(glideCenter(from, to, 1.5)).toEqual(to);
  });

  it('is halfway at half time, and slower near the ends than in the middle', () => {
    const half = glideCenter(from, to, 0.5);
    expect(half.x).toBeCloseTo(100);
    expect(half.y).toBeCloseTo(0);
    const early = glideCenter(from, to, 0.1).x - from.x;
    const middle = glideCenter(from, to, 0.55).x - glideCenter(from, to, 0.45).x;
    expect(early).toBeLessThan(middle);
  });
});

describe('followInto', () => {
  const camera = { zoom: 2, center: { x: 0, y: 0 } };
  // 800 by 600 at zoom 2: the view spans 200 plane units either side of the
  // centre across and 150 up and down; a fifth of it is 160 by 120 pixels.

  it('leaves the view alone while the figure is well inside it', () => {
    expect(followInto(camera, viewport, { x: 100, y: -50 }, 0.2)).toEqual(camera.center);
  });

  it('moves just enough to keep the figure a fifth of the view from the edge it nears', () => {
    // x 150 is at 700 px, 60 px past the 640 px line: the centre moves 30 units.
    const center = followInto(camera, viewport, { x: 150, y: 0 }, 0.2);
    expect(center).toEqual({ x: 30, y: 0 });
    const screen = { x: 400 + (150 - center.x) * 2, y: 300 + (0 - center.y) * 2 };
    expect(screen.x).toBeCloseTo(640);
  });

  it('follows up and to the left as well', () => {
    // x -190 is at 20 px, 140 px short of 160: 70 units. y -140 is at 20 px,
    // 100 px short of 120: 50 units.
    expect(followInto(camera, viewport, { x: -190, y: -140 }, 0.2)).toEqual({ x: -70, y: -50 });
  });
});
