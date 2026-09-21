import type { GameState, NodeId, PathPreview } from '@adventure/core';
import type { Camera, Projection } from './isometric.ts';

/**
 * Draw layers, back to front. Separated because they invalidate on completely
 * different schedules: terrain and dressing are generated once per map, POI
 * markers change only when a reward is claimed, and the path overlay changes on
 * every mouse move.
 *
 * [SOURCE §6] Terrain textures, eye-candy billboards, road/path brush, POI and
 * guardian images, character figurines, the die-roll animation, and the
 * prospective-move visuals are all art (§10).
 */
export type SceneLayer = 'terrain' | 'dressing' | 'edges' | 'nodes' | 'pois' | 'path-overlay' | 'characters' | 'ui';

export interface MapRenderer {
  readonly projection: Projection;
  setCamera(camera: Camera): void;
  /** Full redraw source of truth; no rendering state is derived from events. */
  setState(state: GameState): void;
  /** [SOURCE §4] The thick dotted path, its colours, and the destination cross. */
  setPathPreview(preview: PathPreview | null): void;
  /** [SOURCE §4] Shift-click waypoint marker. */
  setWaypoint(node: NodeId | null): void;
  invalidate(layer: SceneLayer): void;
}

/**
 * How a POI, a guardian, a terrain tile or a reward icon turns into a picture.
 *
 * **Out of scope for this pass, by instruction.** The `Art/` folder holds
 * placeholder sheets (a PNG plus a same-named JSON per sheet, images not to
 * scale with each other), but sheet extraction, sizing and the icon-to-reward
 * mapping are all still to be settled with the designer. Nothing in the repo
 * reads `Art/`, and `Poi.artVariant` is only a stable per-POI random index —
 * what it indexes into is decided here, later.
 */
export interface ArtBinding {
  readonly name: string;
}
