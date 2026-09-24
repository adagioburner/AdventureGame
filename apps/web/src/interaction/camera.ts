import type { Point } from '@adventure/core';
import type { Camera } from '../render/isometric.ts';

/**
 * [SOURCE §4] "Click-drag to pan, `+`/`-` to zoom."
 *
 * Input events are described structurally rather than as DOM types so the
 * controller is testable headlessly; the page turns pointer, wheel and key
 * events into these calls.
 *
 * Phase 3 landed this early, because a map shown whole on a phone is too small
 * to judge art by; phase 4's move mode sits beside it (`moveMode.ts`).
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
  /**
   * Bring a zoom-1 plane point to the middle of the view — the current
   * player's figure, when they ask where it is — zooming in to `zoom` first if
   * the view is further out than that.
   */
  centerOn(plane: Point, zoom: number): void;
  /** Bring a zoom-1 plane point to the middle of the view at the zoom it already has. */
  lookAt(plane: Point): void;
  /** A new fit, when the viewport changes size. */
  setFit(fit: Camera, viewport: Point): void;
}

/** One `+` or `-` press. */
export const ZOOM_STEP = 1.25;
/** Never smaller than a little under the whole-map view. */
export const MIN_ZOOM_OF_FIT = 0.8;
/** Close enough that a POI fills a good part of a phone screen. */
export const MAX_ZOOM = 4;
/**
 * [Andrei, 2026-09-24] Q46: at the start of each turn the map glides to the
 * current player's figure "over about half a second".
 */
export const GLIDE_MS = 500;

/**
 * Where a glide from `from` to `to` has got to at `t`, from 0 to 1. It eases
 * in and out, so the map starts and stops gently rather than at full speed.
 */
export function glideCenter(from: Point, to: Point, t: number): Point {
  const eased = t <= 0 ? 0 : t >= 1 ? 1 : (1 - Math.cos(Math.PI * t)) / 2;
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
}

/**
 * [Andrei, 2026-09-24] Q47: "as the figures move, if they get out of view, the
 * map should also pan to follow them". Following starts once a walking figure
 * is this share of the view from an edge, so it never leaves the screen.
 */
export const FOLLOW_MARGIN_OF_VIEW = 0.2;

/**
 * The view's centre, moved just enough that `plane` sits at least `margin` of
 * the view's width and height inside every edge: the map keeps pace with a
 * walking figure (Q47). A point already that far inside leaves it where it is.
 */
export function followInto(camera: Camera, viewport: Point, plane: Point, margin: number): Point {
  const along = (center: number, point: number, size: number): number => {
    const screen = size / 2 + (point - center) * camera.zoom;
    const low = size * margin;
    const high = size - low;
    if (screen < low) return center - (low - screen) / camera.zoom;
    if (screen > high) return center + (screen - high) / camera.zoom;
    return center;
  };
  return { x: along(camera.center.x, plane.x, viewport.x), y: along(camera.center.y, plane.y, viewport.y) };
}

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
    centerOn(plane, zoom) {
      camera = { zoom: clampZoom(Math.max(camera.zoom, zoom)), center: plane };
    },
    lookAt(plane) {
      camera = { zoom: camera.zoom, center: plane };
    },
    setFit(next, nextViewport) {
      whole = next;
      size = nextViewport;
    },
  };
}
