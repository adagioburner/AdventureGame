import type { GameState, NodeId, PathPreview } from '@adventure/core';
import type { Camera, Projection } from './isometric.ts';

/**
 * Draw layers. Separated because they invalidate on completely different
 * schedules: terrain, roads, nodes and dressing are drawn once per map, POI
 * markers change only when a reward is claimed, characters when someone
 * moves, and the path overlay on every mouse move.
 *
 * They are *logical* layers, not a back-to-front order. Isometric depth
 * decides the order: a tree in front of a castle has to cover it, so
 * dressing, POI images and characters share one depth-sorted plane. What the
 * renderer actually stacks, bottom to top, is
 *
 *   1. the ground — `terrain`, `edges`, `nodes` — laid through the projection;
 *   2. everything standing — `dressing`, `pois`, `characters` — sorted by depth;
 *   3. the `path-overlay`, on the ground but drawn over what stands on it, so
 *      a planned route is never hidden behind a building;
 *   4. `ui`: reward icons, guard numbers and stamina costs, always readable.
 *
 * [SOURCE §6] Terrain textures, eye-candy billboards, road/path brush, POI and
 * guardian images, character figurines, the die-roll animation, and the
 * prospective-move visuals are all art (§10); which picture is used for each
 * is `Art/manifest.json`'s business and nobody else's.
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
