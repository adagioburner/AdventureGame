import type { Point } from '@adventure/core';
import type { Camera } from '../render/isometric.ts';

/**
 * [SOURCE §4] "Click-drag to pan, `+`/`-` to zoom."
 *
 * Input events are described structurally rather than as DOM types so this
 * package stays free of `lib.dom` and the controller is testable headlessly.
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
  /** [SOURCE §1.3, chat] Whole map visible at game start. */
  resetToFit(): void;
}
