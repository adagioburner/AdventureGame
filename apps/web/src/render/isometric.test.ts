import { describe, expect, it } from 'vitest';
import { createCameraController, MAX_ZOOM, MIN_ZOOM_OF_FIT, ZOOM_STEP } from '../interaction/camera.ts';
import { cameraTransform, fitToViewport, isometricProjection, projectBounds, type Affine } from './isometric.ts';

const projection = isometricProjection(10);
const apply = (m: Affine, p: { x: number; y: number }) => ({ x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty });

describe('the isometric projection', () => {
  it('turns the map 45° and squashes it to half height', () => {
    // East and south on the map both run down the screen, east to the right.
    const east = projection.toScreen({ x: 1, y: 0 });
    const south = projection.toScreen({ x: 0, y: 1 });
    expect(east.x).toBeCloseTo(-south.x);
    expect(east.y).toBeCloseTo(south.y);
    expect(east.y / east.x).toBeCloseTo(0.5);
  });

  it('comes back to where it started', () => {
    for (const world of [{ x: 0, y: 0 }, { x: 3.5, y: -2 }, { x: -120, y: 47.25 }]) {
      const back = projection.toWorld(projection.toScreen(world));
      expect(back.x).toBeCloseTo(world.x);
      expect(back.y).toBeCloseTo(world.y);
    }
  });

  it('is exactly the matrix the renderer lays the ground through', () => {
    const world = { x: 7, y: -3 };
    expect(apply(projection.matrix, world)).toEqual(projection.toScreen(world));
  });
});

describe('fitting the whole map on screen', () => {
  const world = { min: { x: 0, y: 0 }, max: { x: 100, y: 60 } };
  const overhang = { top: 40, side: 10, bottom: 10 };

  it('shows the whole map, with room above for what stands on it, at open', () => {
    for (const viewport of [{ x: 1280, y: 800 }, { x: 390, y: 700 }]) {
      const camera = fitToViewport(projection, world, viewport, overhang);
      const place = cameraTransform(camera, viewport);
      const screen = projectBounds(projection, world);
      const topLeft = apply(place, { x: screen.min.x - overhang.side, y: screen.min.y - overhang.top });
      const bottomRight = apply(place, { x: screen.max.x + overhang.side, y: screen.max.y + overhang.bottom });
      expect(topLeft.x).toBeGreaterThanOrEqual(-1e-9);
      expect(topLeft.y).toBeGreaterThanOrEqual(-1e-9);
      expect(bottomRight.x).toBeLessThanOrEqual(viewport.x + 1e-9);
      expect(bottomRight.y).toBeLessThanOrEqual(viewport.y + 1e-9);
      // And it fills one of the two directions.
      const fills = Math.max((bottomRight.x - topLeft.x) / viewport.x, (bottomRight.y - topLeft.y) / viewport.y);
      expect(fills).toBeCloseTo(1);
    }
  });
});

describe('the camera', () => {
  const viewport = { x: 800, y: 600 };
  const fit = fitToViewport(projection, { min: { x: 0, y: 0 }, max: { x: 100, y: 60 } }, viewport);
  const plane = (camera: { center: { x: number; y: number }; zoom: number }, screen: { x: number; y: number }) => {
    const m = cameraTransform(camera, viewport);
    return { x: (screen.x - m.tx) / m.a, y: (screen.y - m.ty) / m.d };
  };

  it('keeps the point under the wheel or the pinch where it is', () => {
    const controller = createCameraController(fit, viewport);
    const under = { x: 610, y: 140 };
    const before = plane(controller.camera, under);
    controller.zoomAt(under, 1.7);
    const after = plane(controller.camera, under);
    expect(controller.camera.zoom).toBeCloseTo(fit.zoom * 1.7);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('moves the map with the drag', () => {
    const controller = createCameraController(fit, viewport);
    const grabbed = plane(controller.camera, { x: 200, y: 200 });
    controller.pan({ from: { x: 200, y: 200 }, to: { x: 260, y: 150 } });
    const now = plane(controller.camera, { x: 260, y: 150 });
    expect(now.x).toBeCloseTo(grabbed.x);
    expect(now.y).toBeCloseTo(grabbed.y);
  });

  it('zooms by one step per key, within its limits, and returns to the whole map', () => {
    const controller = createCameraController(fit, viewport);
    controller.zoomIn();
    expect(controller.camera.zoom).toBeCloseTo(fit.zoom * ZOOM_STEP);
    for (let i = 0; i < 100; i++) controller.zoomIn();
    expect(controller.camera.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i++) controller.zoomOut();
    expect(controller.camera.zoom).toBeCloseTo(fit.zoom * MIN_ZOOM_OF_FIT);
    controller.resetToFit();
    expect(controller.camera).toEqual(fit);
  });
});
