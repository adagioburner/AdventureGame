import type { Point } from '@adventure/core';
import type { Camera } from '../render/isometric.ts';

/**
 * [SOURCE §4] "Click-drag to pan, `+`/`-` to zoom."
 *
 * Input events are described structurally rather than as DOM types so the
 * controller is testable headlessly; the page turns pointer, wheel and key
 * events into these calls.
 *
 * Phase 3 lands this early, and only this much of §7.1's controls, because a
 * map shown whole on a phone is too small to judge art by: the reviewer has to
 * be able to zoom in. Move mode stays phase 4.
 */
export interface PointerDrag {
  readonly from: Point;
  readonly to: Point;
}

export interface CameraController {
  readonly camera: Camera;
  pan(drag: PointerDrag): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Zoom by `factor`, keeping the map point under `screen` where it is — a wheel or a pinch. */
  zoomAt(screen: Point, factor: number): void;
  /** [SOURCE §1.3, chat] Whole map visible at game start. */
  resetToFit(): void;
  /** A new fit, when the viewport changes size. */
  setFit(fit: Camera, viewport: Point): void;
}

/** One `+` or `-` press. */
export const ZOOM_STEP = 1.25;
/** Never smaller than a little under the whole-map view. */
export const MIN_ZOOM_OF_FIT = 0.8;
/** Close enough that a POI fills a good part of a phone screen. */
export const MAX_ZOOM = 4;

export function createCameraController(fit: Camera, viewport: Point): CameraController {
  let whole = fit;
  let size = viewport;
  let camera = fit;

  const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(whole.zoom * MIN_ZOOM_OF_FIT, zoom));

  const zoomAt = (screen: Point, factor: number): void => {
    const zoom = clampZoom(camera.zoom * factor);
    // The zoom-1 plane point under `screen` stays under it.
    const plane = {
      x: camera.center.x + (screen.x - size.x / 2) / camera.zoom,
      y: camera.center.y + (screen.y - size.y / 2) / camera.zoom,
    };
    camera = {
      zoom,
      center: { x: plane.x - (screen.x - size.x / 2) / zoom, y: plane.y - (screen.y - size.y / 2) / zoom },
    };
  };

  return {
    get camera() {
      return camera;
    },
    pan(drag) {
      camera = {
        zoom: camera.zoom,
        center: {
          x: camera.center.x - (drag.to.x - drag.from.x) / camera.zoom,
          y: camera.center.y - (drag.to.y - drag.from.y) / camera.zoom,
        },
      };
    },
    zoomIn() {
      zoomAt({ x: size.x / 2, y: size.y / 2 }, ZOOM_STEP);
    },
    zoomOut() {
      zoomAt({ x: size.x / 2, y: size.y / 2 }, 1 / ZOOM_STEP);
    },
    zoomAt,
    resetToFit() {
      camera = whole;
    },
    setFit(next, nextViewport) {
      whole = next;
      size = nextViewport;
    },
  };
}
