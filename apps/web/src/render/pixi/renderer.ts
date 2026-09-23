import { TERRAINS } from '@adventure/config';
import type { GameMap, GameState, NodeId, PathPreview, Point } from '@adventure/core';
import { Container, Graphics, Matrix, Sprite, Text, TilingSprite, type Texture } from 'pixi.js';
import { spriteIndex } from '../../art/atlas.ts';
import { atlasOf } from '../../art/catalog.ts';
import type { Camera, Projection } from '../isometric.ts';
import type { MapRenderer, SceneLayer } from '../scene.ts';
import {
  buildPathScene,
  buildStateScene,
  buildWaypoint,
  SPACING_PX,
  type Billboard,
  type MapScene,
  type StateScene,
} from '../sceneModel.ts';
import type { LoadedArt } from './textures.ts';

/**
 * `MapRenderer` on PixiJS (docs/STACK.md §3). Everything it draws comes out
 * of `sceneModel.ts`; this file decides only how a scene item becomes a
 * PixiJS object, which is why it has no tests of its own and the scene model
 * has many.
 */
export class PixiMapRenderer implements MapRenderer {
  readonly projection: Projection;
  /** Add this to the stage; the camera moves it. */
  readonly root = new Container();

  private readonly groundBelow = new Container();
  private readonly terrainLayer = new Container();
  private readonly edgesLayer = new Container();
  private readonly nodesLayer = new Container();
  private readonly activeLayer = new Container();
  private readonly standing = new Container({ sortableChildren: true });
  private readonly groundAbove = new Container();
  private readonly ui = new Container();
  private readonly labelsLayer = new Container();
  private readonly costsLayer = new Container();

  private readonly dressingSprites: Sprite[] = [];
  private poiSprites: Sprite[] = [];
  private characterSprites: Sprite[] = [];
  private waypointSprite: Sprite | null = null;

  private state: GameState | null = null;
  private stateScene: StateScene | null = null;
  private preview: PathPreview | null = null;
  private waypoint: NodeId | null = null;
  private viewport: Point = { x: 1, y: 1 };

  constructor(
    private readonly art: LoadedArt,
    private readonly map: GameMap,
    private readonly scene: MapScene,
  ) {
    this.projection = scene.projection;
    const m = scene.projection.matrix;
    for (const ground of [this.groundBelow, this.groundAbove]) {
      ground.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
    }
    this.groundBelow.addChild(this.terrainLayer, this.edgesLayer, this.nodesLayer, this.activeLayer);
    this.ui.addChild(this.labelsLayer, this.costsLayer);
    this.root.addChild(this.groundBelow, this.standing, this.groundAbove, this.ui);
    for (const layer of ['terrain', 'edges', 'nodes', 'dressing', 'pois', 'ui'] as const) this.invalidate(layer);
  }

  setViewport(viewport: Point): void {
    this.viewport = viewport;
  }

  setCamera(camera: Camera): void {
    this.root.scale.set(camera.zoom);
    this.root.position.set(
      this.viewport.x / 2 - camera.center.x * camera.zoom,
      this.viewport.y / 2 - camera.center.y * camera.zoom,
    );
  }

  setState(state: GameState): void {
    if (state.map !== this.map) throw new Error('this renderer draws one map; make a new one for another');
    this.state = state;
    this.stateScene = buildStateScene(this.scene, state, this.art.catalog);
    for (const layer of ['pois', 'characters', 'ui', 'path-overlay'] as const) this.invalidate(layer);
  }

  setPathPreview(preview: PathPreview | null): void {
    this.preview = preview;
    this.invalidate('path-overlay');
  }

  setWaypoint(node: NodeId | null): void {
    this.waypoint = node;
    this.invalidate('characters');
  }

  invalidate(layer: SceneLayer): void {
    switch (layer) {
      case 'terrain':
        return this.drawTerrain();
      case 'edges':
        return this.drawEdges();
      case 'nodes':
        return this.drawNodes();
      case 'dressing':
        return this.drawDressing();
      case 'pois':
        return this.drawPois();
      case 'characters':
        return this.drawCharacters();
      case 'path-overlay':
        return this.drawPath();
      case 'ui':
        return this.drawUi();
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  // --- the ground -------------------------------------------------------------

  private drawTerrain(): void {
    this.terrainLayer.removeChildren().forEach((child) => child.destroy());
    const { manifest } = this.art.catalog;
    for (const terrain of TERRAINS) {
      const art = manifest.terrain[terrain];
      const texture = this.art.tile({ sheet: art.texture, index: 0 });
      const repeat = (art.textureSize * this.scene.spacing) / texture.width;
      const graphics = new Graphics();
      for (const patch of this.scene.terrain) {
        if (patch.terrain !== terrain || patch.polygon.length < 3) continue;
        graphics.poly(grow(patch.polygon, this.scene.spacing * 0.004).flatMap((p) => [p.x, p.y]));
      }
      graphics.fill({ texture, matrix: new Matrix().scale(repeat, repeat), textureSpace: 'global' });
      this.terrainLayer.addChild(graphics);
    }
  }

  private drawEdges(): void {
    this.edgesLayer.removeChildren().forEach((child) => child.destroy());
    const { roads } = this.art.catalog.manifest;
    const atlas = atlasOf(this.art.catalog, roads.sheet);
    const index = spriteIndex(atlas, roads.sprite);
    const sprite = atlas.sprites[index];
    if (sprite === undefined) return;
    const texture = this.art.tile({ sheet: roads.sheet, index });
    const centre = (sprite.centerlineY ?? sprite.height / 2) / sprite.height;
    for (const road of this.scene.roads) {
      const length = Math.hypot(road.to.x - road.from.x, road.to.y - road.from.y);
      const tileScale = road.width / sprite.height;
      const stroke = new TilingSprite({ texture, width: length / tileScale, height: sprite.height });
      stroke.anchor.set(0, centre);
      stroke.scale.set(tileScale);
      stroke.position.set(road.from.x, road.from.y);
      stroke.rotation = Math.atan2(road.to.y - road.from.y, road.to.x - road.from.x);
      this.edgesLayer.addChild(stroke);
    }
  }

  private drawNodes(): void {
    this.nodesLayer.removeChildren().forEach((child) => child.destroy());
    const { manifest } = this.art.catalog;
    const graphics = new Graphics();
    for (const node of this.scene.nodes) {
      graphics
        .circle(node.at.x, node.at.y, node.radius)
        .fill(manifest.terrain[node.terrain].nodeColor)
        .stroke({ color: manifest.nodes.outline, width: node.radius * 0.28 });
    }
    this.nodesLayer.addChild(graphics);
  }

  // --- what stands on it --------------------------------------------------------

  private drawDressing(): void {
    for (const sprite of this.dressingSprites) sprite.destroy();
    this.dressingSprites.length = 0;
    for (const item of this.scene.billboards) {
      if (item.layer === 'dressing') this.dressingSprites.push(this.stand(item, 1));
    }
  }

  private drawPois(): void {
    for (const sprite of this.poiSprites) sprite.destroy();
    this.poiSprites = [];
    const claimed = this.stateScene?.claimed ?? new Set<NodeId>();
    for (const item of this.scene.billboards) {
      if (item.layer !== 'pois') continue;
      const gone = item.node !== null && claimed.has(item.node);
      // §4.5: a claimed POI "behaves like an ordinary node" — its picture
      // stays, faded and without its contour, so the map does not change shape.
      this.poiSprites.push(this.stand(gone ? { ...item, contour: null } : item, gone ? 0.45 : 1));
    }
  }

  private drawCharacters(): void {
    for (const sprite of this.characterSprites) sprite.destroy();
    this.characterSprites = [];
    this.waypointSprite?.destroy();
    this.waypointSprite = null;
    this.activeLayer.removeChildren().forEach((child) => child.destroy());

    for (const item of this.stateScene?.characters ?? []) this.characterSprites.push(this.stand(item, 1));
    const active = this.stateScene?.active ?? null;
    if (active !== null) {
      const ring = new Sprite(this.art.frame(active.sprite));
      ring.anchor.set(0.5);
      ring.scale.set(active.size / ring.texture.width);
      ring.position.set(active.at.x, active.at.y);
      this.activeLayer.addChild(ring);
    }
    if (this.waypoint !== null) {
      this.waypointSprite = this.stand(buildWaypoint(this.scene, this.map, this.waypoint, this.art.catalog), 1);
    }
  }

  private stand(item: Billboard, alpha: number): Sprite {
    const sheet = this.art.sheet(item.sprite.sheet);
    let texture: Texture | undefined = sheet.frames[item.sprite.index];
    const scale = item.size / sheet.typical;
    if (item.contour !== null) {
      const { contour } = this.art.catalog.manifest.guards;
      // The manifest's contour width is in node spacings; turn it into this
      // sheet's texture pixels at the size this sprite is drawn.
      const radius = (contour * SPACING_PX) / scale;
      texture = sheet.contoured(item.contour, radius)[item.sprite.index];
    }
    if (texture === undefined) throw new Error(`${item.sprite.sheet} has no sprite ${item.sprite.index}`);
    const sprite = new Sprite(texture);
    sprite.anchor.copyFrom(texture.defaultAnchor ?? { x: 0.5, y: 1 });
    sprite.scale.set(scale);
    sprite.position.set(item.foot.x, item.foot.y);
    sprite.zIndex = item.depth;
    sprite.alpha = alpha;
    this.standing.addChild(sprite);
    return sprite;
  }

  // --- over everything ----------------------------------------------------------

  private drawPath(): void {
    this.groundAbove.removeChildren().forEach((child) => child.destroy());
    this.costsLayer.removeChildren().forEach((child) => child.destroy());
    const state = this.state;
    const preview = this.preview;
    if (state === null || preview === null) return;
    const from = state.players[state.turn.activeSeat - 1]?.position;
    if (from === undefined) return;
    const path = buildPathScene(this.scene, this.map, from, preview, this.art.catalog);
    const prospect = this.art.catalog.manifest.moveProspect;
    const atlas = atlasOf(this.art.catalog, prospect.sheet);
    const decal = (id: string, at: Point, size: number): void => {
      const sprite = new Sprite(this.art.frame({ sheet: prospect.sheet, index: spriteIndex(atlas, id) }));
      sprite.anchor.set(0.5);
      sprite.scale.set(size / sprite.texture.width);
      sprite.position.set(at.x, at.y);
      this.groundAbove.addChild(sprite);
    };
    for (const dot of path.dots) decal(prospect.dot[dot.color], dot.at, dot.size);
    decal(prospect.cross[path.cross.color], path.cross.at, path.cross.size);
    for (const cost of path.costs) {
      this.costsLayer.addChild(label(cost.text, prospect.costColor, cost.size, cost.at, 0.5, '#2b2419'));
    }
  }

  private drawUi(): void {
    this.labelsLayer.removeChildren().forEach((child) => child.destroy());
    const claimed = this.stateScene?.claimed ?? new Set<NodeId>();
    const { guards } = this.art.catalog.manifest;
    for (const poi of this.scene.labels) {
      if (claimed.has(poi.node)) continue;
      const texture = this.art.icon(poi.icons.kind);
      for (let i = 0; i < poi.icons.count; i++) {
        const icon = new Sprite(texture);
        icon.anchor.set(0.5);
        icon.scale.set(poi.icons.size / Math.max(texture.width, texture.height));
        icon.position.set(poi.icons.first.x + i * poi.icons.step, poi.icons.first.y);
        this.labelsLayer.addChild(icon);
      }
      if (poi.guard !== null) {
        this.labelsLayer.addChild(label(String(poi.guard.strength), guards.colors[poi.guard.type], poi.guard.size, poi.guard.at, 0));
      }
    }
  }
}

/** A bold number with a contrasting edge, legible on any terrain. */
function label(text: string, color: string, size: number, at: Point, anchorX: number, edge = '#ffffff'): Text {
  const label = new Text({
    text,
    resolution: 4,
    style: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontWeight: '900',
      fontSize: size,
      fill: color,
      stroke: { color: edge, width: size * 0.22, join: 'round' },
    },
  });
  label.anchor.set(anchorX, 0.5);
  label.position.set(at.x, at.y);
  return label;
}

/**
 * Neighbouring terrain cells share an edge exactly; drawn as separate shapes
 * the renderer can leave a hairline between them. Growing each a hair past
 * its edge closes it, and cells of one terrain repeat one texture in world
 * space, so the overlap does not show.
 */
function grow(polygon: readonly Point[], by: number): Point[] {
  const cx = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
  const cy = polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length;
  return polygon.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / length) * by, y: p.y + (dy / length) * by };
  });
}
