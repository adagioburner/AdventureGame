import { describe, expect, it } from 'vitest';
import { createCameraController, glideCenter } from './camera.ts';

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
