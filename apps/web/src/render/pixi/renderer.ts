import { TERRAINS } from '@adventure/config';
import type { GameMap, GameState, NodeId, PathPreview, PlayerId, Point } from '@adventure/core';
import { Container, Graphics, Matrix, Sprite, Text, TilingSprite, type Texture } from 'pixi.js';
import { spriteIndex } from '../../art/atlas.ts';
import { atlasOf } from '../../art/catalog.ts';
import type { Camera, Projection } from '../isometric.ts';
import type { Box } from '../placement.ts';
import type { MapRenderer, SceneLayer } from '../scene.ts';
import {
  buildCharacters,
  buildPathScene,
  buildStateScene,
  buildTurnBubbles,
  buildWaypoint,
  figuresAnimate,
  guardRing,
  nodeOutlineWidth,
  nextIdlePlay,
  playerRingSize,
  playFrame,
  siteDot,
  SPACING_PX,
  TURN_BUBBLE,
  type Billboard,
  type Figure,
  type FigureCue,
  type MapScene,
  type PlayerRing,
  type StateScene,
  type Walker,
} from '../sceneModel.ts';
import { backdropTerrains } from '../dressing.ts';
import type { LoadedArt } from './textures.ts';

/**
 * The current player's cue, in node spacings and milliseconds. Pulsing grows
 * their ring (Q305, 11) to `pulseGrow` times its size as it fades out, then
 * starts it again at its own, once a period, so it can be found even with the
 * whole map in view; the figure stays solid (Q321). Planning holds the ring
 * steady with a thick `color` outline `outline` wide round it (Q305, 10).
 */
const CUE = {
  pulseMs: 1000,
  pulseGrow: 2,
  outline: 0.05,
  color: 0xffd84a,
} as const;

/**
 * [Q305, 9, 13] The ring under every figure, in node spacings: a see-through
 * gold disc (`color`), with a rim of it `rim` wide; a selected one's
 * outline goes round it `gap` out. Andrei: "let us try it without the black
 * outlines". [Q312, 1] The page's own player's is `own` instead, disc and
 * rim alike, and nothing else differs. Andrei, after orange inside the gold
 * rim: "can you show me white disk instead of orange? maybe that's going to
 * look better"; of the mockups, he picked white with a white rim.
 */
const PLAYER_RING = { color: 0xffe878, own: 0xffffff, fillAlpha: 0.5, rim: 0.06, gap: 0.035 } as const;

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

  /** [Q170] The rock hanging under the map's front edges, its stone tops fading into the ground's edge (679). */
  private readonly underside = new Container();
  private readonly terrainLayer = new Container();
  private readonly backdrop = new Container();
  /** The backdrop's own terrain, laid through the projection: the backdrop is clipped to it. */
  private readonly backdropGround = new Container();
  private readonly groundBelow = new Container();
  /** [Q305, 3] The rings under the figures, under the roads and nodes so they hide nothing. */
  private readonly ringsLayer = new Container();
  private readonly edgesLayer = new Container();
  private readonly nodesLayer = new Container();
  private readonly standing = new Container({ sortableChildren: true });
  private readonly groundAbove = new Container();
  private readonly ui = new Container();
  private readonly labelsLayer = new Container();
  /** [Q315] The turn bubbles over a route being planned, over everything else. */
  private readonly bubblesLayer = new Container();

  private readonly dressingSprites: Sprite[] = [];
  private poiSprites: Sprite[] = [];
  private characterSprites: Sprite[] = [];
  private waypointSprite: Sprite | null = null;
  private cue: FigureCue = 'none';
  private planner: PlayerId | null = null;
  private found: PlayerId | null = null;
  private own: PlayerId | null = null;
  /** What the pulse animates: (Q305, 11) the current player's ring. */
  private pulsing: Graphics | null = null;
  /**
   * [Q305, 15-18] The figures drawn now that have an idle loop: its frames,
   * the one showing, and whether the figure stands still whatever the zoom.
   */
  private figures: { sprite: Sprite; player: PlayerId; size: number; frames: readonly Texture[]; durationsMs: readonly number[]; still: boolean; shown: number }[] = [];
  /** [Q305, 15] Each player's idle loop: when it next plays, and when the one playing started. */
  private readonly idle = new Map<PlayerId, { next: number; start: number | null }>();

  private state: GameState | null = null;
  private stateScene: StateScene | null = null;
  private preview: PathPreview | null = null;
  private previewFrom: NodeId | null = null;
  private turnStops: readonly number[] | null = null;
  /** [Q320, 9] The turn bubbles as drawn, which the edge markers keep off. */
  private bubbleBoxes: Box[] = [];
  private waypoint: NodeId | null = null;
  private walker: Walker | null = null;
  private viewport: Point = { x: 1, y: 1 };
  /** [Q305, 8] The map's zoom, and the zoom that shows it whole, which keep the rings under the figures from getting too small. */
  private zoom = 1;
  private wholeZoom = 0;

  constructor(
    private readonly art: LoadedArt,
    private readonly map: GameMap,
    private readonly scene: MapScene,
  ) {
    this.projection = scene.projection;
    const m = scene.projection.matrix;
    for (const ground of [this.terrainLayer, this.backdropGround, this.groundBelow, this.groundAbove]) {
      ground.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
    }
    this.groundBelow.addChild(this.ringsLayer, this.edgesLayer, this.nodesLayer);
    this.ui.addChild(this.labelsLayer, this.bubblesLayer);
    // The backdrop is painted on the ground, under the roads and nodes;
    // `scene.billboards` already lists it back to front.
    this.root.addChild(
      this.terrainLayer,
      this.backdropGround,
      this.backdrop,
      this.underside,
      this.groundBelow,
      this.standing,
      this.groundAbove,
      this.ui,
    );
    this.clipBackdrop();
    this.drawUnderside();
    for (const layer of ['terrain', 'edges', 'nodes', 'dressing', 'pois', 'ui'] as const) this.invalidate(layer);
  }

  setViewport(viewport: Point): void {
    this.viewport = viewport;
  }

  setCamera(camera: Camera, whole: Camera): void {
    this.root.scale.set(camera.zoom);
    this.root.position.set(
      this.viewport.x / 2 - camera.center.x * camera.zoom,
      this.viewport.y / 2 - camera.center.y * camera.zoom,
    );
    if (camera.zoom !== this.zoom || whole.zoom !== this.wholeZoom) {
      this.zoom = camera.zoom;
      this.wholeZoom = whole.zoom;
      this.drawPlayerRings();
    }
  }

  setState(state: GameState): void {
    if (state.map !== this.map) throw new Error('this renderer draws one map; make a new one for another');
    this.state = state;
    this.stateScene = buildStateScene(this.scene, state, this.art.catalog, this.walker, this.planner, this.found, this.own);
    for (const layer of ['nodes', 'pois', 'characters', 'ui', 'path-overlay'] as const) this.invalidate(layer);
  }

  /** A figure part-way along a road while End Turn plays out; `null` when nobody is walking. */
  setWalker(walker: Walker | null): void {
    this.walker = walker;
    if (this.state === null || this.stateScene === null) return;
    this.stateScene = { ...this.stateScene, ...buildCharacters(this.scene, this.state, this.art.catalog, walker, this.planner, this.found, this.own) };
    this.invalidate('characters');
  }

  /** [Q56, 49] The player planning out of turn, whose figure is highlighted; `null` for none. */
  setPlanner(planner: PlayerId | null): void {
    if (planner === this.planner) return;
    this.planner = planner;
    if (this.state === null || this.stateScene === null) return;
    this.stateScene = { ...this.stateScene, ...buildCharacters(this.scene, this.state, this.art.catalog, this.walker, planner, this.found, this.own) };
    this.invalidate('characters');
  }

  /** [Q120, 471] The player whose card was just clicked, whose figure stands on a ring; `null` for none. */
  setFound(found: PlayerId | null): void {
    if (found === this.found) return;
    this.found = found;
    if (this.state === null || this.stateScene === null) return;
    this.stateScene = { ...this.stateScene, ...buildCharacters(this.scene, this.state, this.art.catalog, this.walker, this.planner, found, this.own) };
    this.invalidate('characters');
  }

  /** [Q312] The player this page is for, whose figure's ring is white; `null` for none. */
  setOwn(own: PlayerId | null): void {
    if (own === this.own) return;
    this.own = own;
    if (this.state === null || this.stateScene === null) return;
    this.stateScene = { ...this.stateScene, ...buildCharacters(this.scene, this.state, this.art.catalog, this.walker, this.planner, this.found, own) };
    this.invalidate('characters');
  }

  /** The figures as drawn now, for telling which one a click landed on. */
  get characters(): readonly Figure[] {
    return this.stateScene?.characters ?? [];
  }

  /** [Q320, 7] The sites whose reward is gone, drawn without their icons or number. */
  get claimed(): ReadonlySet<NodeId> {
    return this.stateScene?.claimed ?? new Set();
  }

  /** [Q320, 8] The rings under the figures as they stand now. */
  get rings(): readonly PlayerRing[] {
    return this.stateScene?.rings ?? [];
  }

  /** [Q320, 9] The boxes the route's turn bubbles cover, point and edge included. */
  get turnBubbles(): readonly Box[] {
    return this.bubbleBoxes;
  }

  setPathPreview(preview: PathPreview | null, from: NodeId | null, turnStops: readonly number[] | null = null): void {
    this.preview = preview;
    this.previewFrom = from;
    this.turnStops = turnStops;
    this.invalidate('path-overlay');
  }

  setWaypoint(node: NodeId | null): void {
    this.waypoint = node;
    this.invalidate('characters');
  }

  setCue(cue: FigureCue): void {
    if (cue === this.cue) return;
    this.cue = cue;
    this.invalidate('characters');
  }

  /** Advance the figures' idle loops and the pulse; call once a frame. */
  tick(now: number): void {
    this.playIdle(now);
    if (this.cue !== 'pulse') return;
    const phase = (now % CUE.pulseMs) / CUE.pulseMs;
    if (this.pulsing !== null) {
      this.pulsing.scale.set(1 + (CUE.pulseGrow - 1) * phase);
      this.pulsing.alpha = 1 - phase;
    }
  }

  /**
   * [Q305, 15-18] Now and then each figure plays its idle loop once, when it
   * is drawn big enough, and stands in its first frame the rest of the time.
   */
  private playIdle(now: number): void {
    for (const figure of this.figures) {
      let idle = this.idle.get(figure.player);
      if (idle === undefined) {
        idle = { next: nextIdlePlay(now, Math.random()), start: null };
        this.idle.set(figure.player, idle);
      }
      if (figure.still || !figuresAnimate(figure.size, this.zoom)) {
        // A play due while it cannot be seen is skipped, not saved up.
        idle.start = null;
        if (now >= idle.next) idle.next = nextIdlePlay(now, Math.random());
      } else if (idle.start === null && now >= idle.next) {
        idle.start = now;
      }
      let frame = 0;
      if (idle.start !== null) {
        const playing = playFrame(figure.durationsMs, idle.start, now);
        if (playing === null) {
          idle.start = null;
          idle.next = nextIdlePlay(now, Math.random());
        } else {
          frame = playing;
        }
      }
      if (frame !== figure.shown) {
        figure.shown = frame;
        figure.sprite.texture = figure.frames[frame] ?? figure.sprite.texture;
      }
    }
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

  /**
   * [Q170] Andrei's rock, stretched so its top edges lie along the map's two
   * front edges. It is drawn over the ground, under the roads, nodes and
   * everything standing, and the stone tops that rise above those edges fade
   * into the ground (679); it ends flush with the ground's back edges at the
   * side corners (681, `shapeUnderside`).
   */
  private drawUnderside(): void {
    const sprite = new Sprite(this.art.underside);
    const m = this.scene.underside;
    sprite.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
    this.underside.addChild(sprite);
  }

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
    const { catalog } = this.art;
    const { manifest } = catalog;
    const { spacing } = this.scene;
    const graphics = new Graphics();
    for (const node of this.stateScene?.nodes ?? this.scene.nodes) {
      graphics
        .circle(node.at.x, node.at.y, node.radius)
        .fill(manifest.terrain[node.terrain].nodeColor)
        .stroke({ color: manifest.nodes.outline, width: nodeOutlineWidth(catalog) * spacing });
      const ring = guardRing(catalog, spacing, node);
      if (ring !== null && node.guard !== null) {
        graphics.circle(node.at.x, node.at.y, ring.radius).stroke({ color: manifest.guards.colors[node.guard], width: ring.width });
      }
      const dot = siteDot(catalog, node);
      if (dot !== null) graphics.circle(node.at.x, node.at.y, dot.radius).fill(dot.color);
    }
    this.nodesLayer.addChild(graphics);
  }

  /**
   * The backdrop is sized and placed to stay over its own terrain, but a
   * picture is not the triangle its placement assumes; clipping it to the
   * terrain's cells cuts off whatever still reaches past, the map's edge
   * included.
   */
  private clipBackdrop(): void {
    const terrains = backdropTerrains(this.art.catalog.manifest);
    if (terrains.size === 0) return;
    const mask = new Graphics();
    for (const patch of this.scene.terrain) {
      if (!terrains.has(patch.terrain) || patch.polygon.length < 3) continue;
      mask.poly(grow(patch.polygon, this.scene.spacing * 0.004).flatMap((p) => [p.x, p.y])).fill(0xffffff);
    }
    this.backdropGround.addChild(mask);
    this.backdrop.mask = mask;
  }

  // --- what stands on it --------------------------------------------------------

  private drawDressing(): void {
    for (const sprite of this.dressingSprites) sprite.destroy();
    this.dressingSprites.length = 0;
    for (const item of this.scene.billboards) {
      if (item.layer === 'backdrop') this.dressingSprites.push(this.stand(item, 1, this.backdrop));
      if (item.layer === 'dressing') this.dressingSprites.push(this.stand(item, 1));
    }
  }

  private drawPois(): void {
    for (const sprite of this.poiSprites) sprite.destroy();
    this.poiSprites = [];
    for (const item of this.scene.billboards) {
      if (item.layer !== 'pois') continue;
      // §4.5: a claimed POI "behaves like an ordinary node". [Andrei,
      // 2026-09-23] "The claimed POIs should lose their icons, but the images
      // DO NOT CHANGE": its picture is drawn exactly as before, and only its
      // icons, number and guard ring go (`drawUi`, `buildStateScene`).
      this.poiSprites.push(this.stand(item, 1));
    }
  }

  private drawCharacters(): void {
    for (const sprite of this.characterSprites) sprite.destroy();
    this.characterSprites = [];
    this.waypointSprite?.destroy();
    this.waypointSprite = null;
    this.figures = [];
    this.drawPlayerRings();

    const state = this.state;
    const current = state === null ? undefined : state.players[state.turn.activeSeat - 1]?.id;
    for (const item of this.stateScene?.characters ?? []) {
      const sprite = this.stand(item, 1);
      this.characterSprites.push(sprite);
      if (item.loop !== null) {
        // [Q305, 18] A figure walking at End turn or picked up to plan (on its
        // turn or out of it, Q56) stands still; [Q321, 2] one on its turn
        // with its ring pulsing plays its loop like the rest.
        const pickedUp = (item.player === current && this.cue === 'selected') || item.player === this.planner;
        this.figures.push({
          sprite,
          player: item.player,
          size: item.size,
          frames: item.loop.frames.map((ref) => this.art.frame(ref)),
          durationsMs: item.loop.durationsMs,
          still: item.walking || pickedUp,
          shown: 0,
        });
      }
    }
    if (this.waypoint !== null) {
      this.waypointSprite = this.stand(buildWaypoint(this.scene, this.map, this.waypoint, this.art.catalog), 1);
    }
  }

  /**
   * [Q305] The one ring under every figure (1), no smaller on screen than it
   * is with the whole map in view (8). The player on turn's pulses until they
   * pick their figure up, and is outlined while they plan (10, 11), as is the
   * ring of a player planning out of turn [Q56, 49] or just found from their card
   * [Q120, 471]; while a turn plays out it is plain like the rest. [Q312] The
   * page's own player's is white, over the rings it overlaps.
   */
  private drawPlayerRings(): void {
    this.ringsLayer.removeChildren().forEach((child) => child.destroy());
    this.pulsing = null;
    const { spacing } = this.scene;
    for (const { at, size, mark, own } of this.stateScene?.rings ?? []) {
      const radius = playerRingSize(size, spacing, this.zoom, this.wholeZoom) / 2;
      const outlined = mark === 'planning' || mark === 'found' || (mark === 'turn' && this.cue === 'selected');
      const color = own ? PLAYER_RING.own : PLAYER_RING.color;
      // Drawn round its own origin, so a pulse grows it from its middle.
      const ring = new Graphics()
        .circle(0, 0, radius)
        .fill({ color, alpha: PLAYER_RING.fillAlpha })
        .stroke({ color, width: PLAYER_RING.rim * spacing });
      if (outlined) ring.circle(0, 0, radius + PLAYER_RING.gap * spacing).stroke({ color: CUE.color, width: CUE.outline * spacing });
      ring.position.set(at.x, at.y);
      this.ringsLayer.addChild(ring);
      if (mark === 'turn' && this.cue === 'pulse') this.pulsing = ring;
    }
  }

  private stand(item: Billboard, alpha: number, parent: Container = this.standing): Sprite {
    const sheet = this.art.sheet(item.sprite.sheet);
    const texture = sheet.frames[item.sprite.index];
    if (texture === undefined) throw new Error(`${item.sprite.sheet} has no sprite ${item.sprite.index}`);
    const sprite = new Sprite(texture);
    sprite.anchor.copyFrom(texture.defaultAnchor ?? { x: 0.5, y: 1 });
    sprite.scale.set(item.size / sheet.typical);
    sprite.position.set(item.foot.x, item.foot.y);
    sprite.zIndex = item.depth;
    sprite.alpha = alpha;
    parent.addChild(sprite);
    return sprite;
  }

  // --- over everything ----------------------------------------------------------

  private drawPath(): void {
    this.groundAbove.removeChildren().forEach((child) => child.destroy());
    this.bubblesLayer.removeChildren().forEach((child) => child.destroy());
    this.bubbleBoxes = [];
    const preview = this.preview;
    const from = this.previewFrom;
    if (preview === null || from === null) return;
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
    if (this.turnStops !== null) {
      for (const bubble of buildTurnBubbles(this.scene, this.map, preview, this.turnStops)) this.drawTurnBubble(bubble.at, bubble.text);
    }
  }

  /** [Q315, 1 B] A white bubble standing above the space at `at`, pointing down at it, with the turn in it. */
  private drawTurnBubble(at: Point, text: string): void {
    const unit = SPACING_PX;
    const type = new Text({
      text,
      resolution: 4,
      style: {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontWeight: '900',
        fontSize: TURN_BUBBLE.fontSize * unit,
        fill: TURN_BUBBLE.ink,
      },
    });
    const height = TURN_BUBBLE.height * unit;
    const width = Math.max(TURN_BUBBLE.minWidth * unit, type.width + 2 * TURN_BUBBLE.padding * unit);
    const bottom = at.y - TURN_BUBBLE.lift * unit;
    const top = bottom - height;
    const half = (TURN_BUBBLE.pointWidth * unit) / 2;
    const edge = { color: TURN_BUBBLE.ink, width: TURN_BUBBLE.outline * unit };
    const shape = new Graphics();
    shape.roundRect(at.x - width / 2, top, width, height, height * TURN_BUBBLE.corner).fill(TURN_BUBBLE.fill).stroke(edge);
    shape.poly([at.x - half, bottom, at.x, at.y, at.x + half, bottom]).fill(TURN_BUBBLE.fill).stroke({ ...edge, join: 'round' });
    // Where the point meets the box, the box's edge is painted over.
    shape.rect(at.x - half + edge.width / 2, bottom - edge.width * 1.2, 2 * half - edge.width, edge.width * 1.6).fill(TURN_BUBBLE.fill);
    type.anchor.set(0.5);
    type.position.set(at.x, top + height / 2);
    this.bubblesLayer.addChild(shape, type);
    this.bubbleBoxes.push({ minX: at.x - width / 2 - edge.width / 2, minY: top - edge.width / 2, maxX: at.x + width / 2 + edge.width / 2, maxY: at.y + edge.width / 2 });
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

/** A bold number with a white edge, legible on any terrain. */
function label(text: string, color: string, size: number, at: Point, anchorX: number): Text {
  const label = new Text({
    text,
    resolution: 4,
    style: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontWeight: '900',
      fontSize: size,
      fill: color,
      stroke: { color: '#ffffff', width: size * 0.22, join: 'round' },
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
