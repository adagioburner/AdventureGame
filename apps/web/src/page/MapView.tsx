import { useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import { DEFAULT_RULESET } from '@adventure/config';
import type { GameMap, GameState, NodeId, PathPreview, PlayerId, Point } from '@adventure/core';
import {
  createCameraController,
  FOLLOW_MARGIN_OF_VIEW,
  followInto,
  glideCenter,
  GLIDE_MS,
  ROOM_MARGIN_PX,
  roomFor,
  type CameraController,
  type ScreenBox,
} from '../interaction/camera.ts';
import { edgeMarkers, type EdgeMarkerLayout, type FigureOnScreen } from '../interaction/offscreen.ts';
import { figureTop, pick, planeToScreen, screenToPlane, type Pick } from '../interaction/picking.ts';
import { fitToViewport, type Camera } from '../render/isometric.ts';
import { position } from '../render/geometry.ts';
import { pictureBox, type Box } from '../render/placement.ts';
import { undersideDepth } from '../render/island.ts';
import { PixiMapRenderer } from '../render/pixi/renderer.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import {
  buildPathScene,
  buildWaypoint,
  figuresAtWalkEnd,
  labelBox,
  playerRingSize,
  SPACING_PX,
  type Figure,
  type FigureCue,
  type MapScene,
  type PlayerRing,
  type Walker,
} from '../render/sceneModel.ts';
import { MAP_RESTORE_WAIT_MS, MAP_RETRY_MS, noteMapTrouble } from './mapTrouble.ts';
import { skyScale } from './sky.ts';
import { Portrait } from './Sprites.tsx';

/** What the page can ask of the map once it is up. */
export interface MapHandle {
  /** Where a node shows in the map's box, in CSS pixels. */
  screenOf(node: NodeId): Point;
  /** Where the top of a player's figure shows in the map's box, as it is drawn right now. */
  screenOfFigure(player: PlayerId): Point | null;
  /**
   * [Andrei, 2026-09-30] Q120, 470: a player's card, or [Q310, 2] Find me,
   * was clicked. Bring their figure to the middle, wherever it has got to on a
   * walk, zoomed in enough to play at.
   */
  centerOnFigure(player: PlayerId): void;
  /**
   * Slide a node to the middle over `GLIDE_MS`, at the zoom the view already
   * has. Panning, zooming or `centerOnFigure` while it slides stops it where it is,
   * and so does a walk that has to take the map along (Q47). Nothing slides
   * when the node is in the middle already.
   */
  glideTo(node: NodeId): void;
  /** [Q318] Whether the map is still sliding somewhere (`glideTo`, `track`, `makeRoom`). */
  gliding(): boolean;
  /**
   * [Q57, 74] Track was pressed: glide to the figure that is walking, if one
   * is, or else to `node`, and follow walks from now on.
   */
  track(node: NodeId | null): void;
  /**
   * [Q314, 6] A mark for "the map is following now", or null when it is not.
   * `makeRoom` with it does nothing once the viewer has pressed, panned or
   * zoomed the map, or something else has taken the map somewhere, since.
   */
  followMark(): number | null;
  /**
   * [Andrei, 2026-10-26] Q314, 6 and 7: slide the map just far enough that
   * `box`, in CSS pixels in the map's box, is not cut off by its edges, over
   * `GLIDE_MS` at the zoom the view already has, as `glideTo` does. Nothing,
   * if `mark` from `followMark` no longer holds.
   */
  makeRoom(box: ScreenBox, mark: number): void;
}

interface MapViewProps {
  readonly art: LoadedArt;
  readonly map: GameMap;
  /** `buildMapScene` of `map`: built once per map by the page, not per render. */
  readonly scene: MapScene;
  readonly state: GameState;
  /** §7.1's dotted route and cross. */
  readonly path: PathPreview | null;
  /**
   * The node `path` starts from: the figure of the player it is for, who
   * online may be someone planning out of turn ([Q56, 49]). The current
   * player's node if omitted.
   */
  readonly pathFrom?: NodeId | null;
  /** [Q315] Where each turn of `path` ends, for its turn bubbles; `null`, as if omitted, for none. */
  readonly turnStops?: readonly number[] | null;
  readonly waypoint: NodeId | null;
  readonly walker: Walker | null;
  /** How the current player's figure calls attention to itself; `none` if omitted. */
  readonly cue?: FigureCue;
  /** [Q56, 49] Online, the player planning out of turn, whose figure is highlighted. */
  readonly planner?: PlayerId | null;
  /** [Q120, 471] The player whose card was just clicked, whose figure is highlighted for a moment. */
  readonly found?: PlayerId | null;
  /**
   * [Q320] Shows a marker at the edge of the map for every player whose
   * figure is out of view; tapping one calls this, as their card does (Q120).
   * No markers if omitted.
   */
  readonly onFind?: ((player: PlayerId) => void) | undefined;
  /** A click or tap, as opposed to a drag; `shift` for a shift-click. */
  readonly onTap?: (target: Pick, shift: boolean) => void;
  /** [Q57] Whether Track is pressed, as its button shows. Pressed if omitted. */
  readonly tracking?: boolean;
  /**
   * Whether a walking figure takes the map along (Q47): while Track is
   * pressed, and [Q316, 3] during the walk of the player's own End turn. As
   * `tracking` if omitted.
   */
  readonly follow?: boolean;
  /** [Q316, 4] Moving the map leaves the following on: on the player's own turn, whose walk it always follows. */
  readonly keepFollowing?: boolean;
  /** [Q57, 72] Shows the Track button, above "+", which calls this. */
  readonly onTrack?: (() => void) | undefined;
  /** [Q63, 139] Shows the Sound button before Track: whether sound is on, and what pressing it does. */
  readonly sound?: { readonly on: boolean; onToggle(): void } | undefined;
  /** [Q57, 73] The viewer dragged, pinched or zoomed the map, or pressed "+", "−" or "Whole map". */
  readonly onMoved?: () => void;
  readonly onReady?: (handle: MapHandle | null) => void;
  /**
   * What Whole map and the first view frame: `map`, the ground and what stands
   * on it, as games do (672 B); or `island`, the rock under it too, as the New
   * game screen does (674; Andrei, 2026-10-01 16:53). `map` if omitted.
   */
  readonly frame?: 'map' | 'island';
}

/** Room above, beside and below the ground that pictures on the edge nodes stand in. */
const OVERHANG = { top: SPACING_PX * 1.2, side: SPACING_PX * 0.5, bottom: SPACING_PX * 0.5 };

/** Sky left under the rock's lowest point when the whole island is framed. */
const ISLAND_SKY_BELOW = SPACING_PX * 0.2;

/**
 * [Q320] How far an edge marker's arrow reaches out of its badge and its rim
 * round it (index.html), the room left between the arrow's tip and the map's
 * edge, and between the rims of two markers side by side, in CSS pixels.
 */
const MARKER = { arrow: 14, rim: 4, margin: 6, gap: 12 } as const;

/** A press that travels less than this, in CSS pixels, is a click rather than a drag. */
const TAP_TRAVEL_PX = 8;

/** Zoom, relative to the whole-map view, that a player's card (Q120) and Find me (Q310) bring the map to at least. */
const PLAY_ZOOM_OF_FIT = 2.2;

/**
 * [Q160, 632 A] On the larger map a card and Find me come as
 * close as on the standard map's: its whole-map view is smaller by the square
 * root of how many more spaces it has, so the zoom grows by as much. 1 on the
 * standard map.
 */
function playZoomScale(map: GameMap): number {
  return Math.sqrt(map.ruleset.config.map.MAP_NODE_COUNT / DEFAULT_RULESET.config.map.MAP_NODE_COUNT);
}

export function MapView({
  art,
  map: gameMap,
  scene,
  state,
  path,
  pathFrom,
  turnStops = null,
  waypoint,
  walker,
  cue = 'none',
  planner = null,
  found = null,
  onFind,
  onTap,
  tracking = true,
  follow = tracking,
  keepFollowing = false,
  onTrack,
  sound,
  onMoved,
  onReady,
  frame = 'map',
}: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const sky = useRef<HTMLDivElement>(null);
  const renderer = useRef<PixiMapRenderer | null>(null);
  const zoomButtons = useRef<((action: 'in' | 'out' | 'fit') => void) | null>(null);
  const buttons = useRef<HTMLDivElement>(null);
  // [Q320] The edge markers, by player, which the map places every frame,
  // and how wide one is: 48 px, 40 on a phone (index.html).
  const markers = useRef(new Map<PlayerId, HTMLButtonElement>());
  const [markerSize, setMarkerSize] = useState(48);
  // Read when the renderer comes up, and by the pointer handlers, which are
  // bound once per map.
  const from = pathFrom ?? state.players[state.turn.activeSeat - 1]?.position ?? null;
  const latest = useRef({ state, path, from, turnStops, waypoint, walker, cue, planner, found, keepFollowing, onTap, onMoved, onReady });
  latest.current = { state, path, from, turnStops, waypoint, walker, cue, planner, found, keepFollowing, onTap, onMoved, onReady };
  // Whether a walk takes the map along. It follows `follow`, and stops at once
  // when the map is moved, before the page has unpressed Track.
  const following = useRef(follow);
  // [Q314, 6] Counts the times the viewer or the page took the map somewhere,
  // so that a notice's room is made only while nothing has since.
  const aims = useRef(0);
  // [Q86, 330 and 331] Counts up to build the map again after it failed to
  // start or lost its drawing surface; `broken` once that happened too often.
  const [build, setBuild] = useState(0);
  const [broken, setBroken] = useState(false);
  const troubles = useRef<readonly number[]>([]);
  // The view to come back to when the map is built again, if the viewer had moved it.
  const kept = useRef<Camera | null>(null);
  // What the view frames, read by the map once it is up; `refit` frames it again.
  const framing = useRef(frame);
  framing.current = frame;
  const refit = useRef<(() => void) | null>(null);

  useEffect(() => {
    const found = host.current;
    if (found === null || broken) return;
    const element: HTMLDivElement = found;
    let disposed = false;
    let troubled = false;
    const app = new Application();
    const cleanups: (() => void)[] = [];
    /** Something went wrong: build the map again after `waitMs`, or stop and say so. */
    const trouble = (waitMs: number): void => {
      if (disposed || troubled) return;
      troubled = true;
      const noted = noteMapTrouble(troubles.current, performance.now());
      troubles.current = noted.times;
      if (!noted.rebuild) {
        setBroken(true);
        return;
      }
      const timer = window.setTimeout(() => setBuild((count) => count + 1), waitMs);
      cleanups.push(() => window.clearTimeout(timer));
    };

    // A surface lost as the map starts makes the drawing library fail here
    // rather than freeze the page (patches/pixi.js@8.21.0.patch).
    void (async () => {
      try {
        await start();
      } catch (error) {
        console.error('The map could not be drawn.', error);
        trouble(MAP_RETRY_MS);
      }
    })();

    async function start(): Promise<void> {
      await app.init({
        resizeTo: element,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        preference: 'webgl',
      });
      if (disposed) {
        app.destroy(true, { children: true });
        return;
      }
      if (surfaceLost(app)) throw new Error('the drawing surface was lost as the map started');
      element.appendChild(app.canvas);

      const map = new PixiMapRenderer(art, gameMap, scene);
      const now = latest.current;
      map.setWalker(now.walker);
      map.setPlanner(now.planner);
      map.setFound(now.found);
      map.setState(now.state);
      map.setPathPreview(now.path, now.from, now.turnStops);
      map.setWaypoint(now.waypoint);
      map.setCue(now.cue);
      app.stage.addChild(map.root);
      app.ticker.add(() => map.tick(performance.now()));
      renderer.current = map;

      const viewport = (): Point => ({ x: element.clientWidth, y: element.clientHeight });
      const islandOverhang = {
        ...OVERHANG,
        bottom: Math.max(OVERHANG.bottom, undersideDepth(scene.projection, scene.bounds, scene.underside, art.undersideSolid) + ISLAND_SKY_BELOW),
      };
      const fit = () => fitToViewport(scene.projection, scene.bounds, viewport(), framing.current === 'island' ? islandOverhang : OVERHANG);
      const camera: CameraController = createCameraController(fit(), viewport());
      let touched = false;
      const was = kept.current;
      kept.current = null;
      if (was !== null) {
        camera.centerOn(was.center, was.zoom);
        touched = true;
      }
      // [676 to 678] The sky behind the map stays put as it is dragged and
      // grows a little as it is zoomed in. It fills the map's whole stage,
      // which on a phone's New game screen runs on under the form.
      const placeSky = (): void => {
        const layer = sky.current;
        if (layer === null) return;
        layer.style.transform = `scale(${skyScale(fit(), camera.camera)})`;
      };
      const apply = (): void => {
        map.setViewport(viewport());
        map.setCamera(camera.camera, fit());
        placeSky();
      };
      apply();

      // [Q86, 330] The device can take the drawing surface away, as a phone
      // short of memory does: the map is built again on a new one, where the
      // viewer had moved it to, whether or not the old one comes back.
      const onLost = (): void => {
        if (touched) kept.current = camera.camera;
        trouble(MAP_RESTORE_WAIT_MS);
      };
      const onRestored = (): void => {
        if (!disposed) setBuild((count) => count + 1);
      };
      app.canvas.addEventListener('webglcontextlost', onLost);
      app.canvas.addEventListener('webglcontextrestored', onRestored);
      cleanups.push(() => {
        app.canvas.removeEventListener('webglcontextlost', onLost);
        app.canvas.removeEventListener('webglcontextrestored', onRestored);
      });

      // `chasing` for a glide the walk's own following waits for: Track's to a
      // walking figure, which aims at wherever the figure is by then, and the
      // glide that makes room for a turn's notice (Q314, 6), which would
      // otherwise stop as the following catches up with the walk's last step.
      let glide: { from: Point; to: () => Point; start: number; chasing: boolean } | null = null;
      // [Andrei, 2026-09-24] Q47: a walking figure that nears the edge of the
      // view takes the map along with it, while Track is pressed (Q57).
      const stopCamera = (): void => {
        glide = null;
        following.current = false;
      };
      /** [Q316, 4] On the player's own turn moving the map stops a glide, while a walk is followed still. */
      const halt = (): void => {
        // [Q314, 6] Either way the map has been taken somewhere: no more room is made for a notice on its way.
        aims.current++;
        if (latest.current.keepFollowing) glide = null;
        else stopCamera();
      };
      /** The viewer moved the map: [Q57, 73] Track unpresses. */
      const moved = (): void => {
        halt();
        latest.current.onMoved?.();
      };
      const onTick = (): void => {
        const walker = latest.current.walker;
        if (walker !== null && following.current && glide?.chasing !== true) {
          const to = followInto(camera.camera, viewport(), scene.projection.toScreen(walker.at), FOLLOW_MARGIN_OF_VIEW);
          if (to.x !== camera.camera.center.x || to.y !== camera.camera.center.y) {
            // A walk that starts while the turn's glide is still sliding takes over from it.
            glide = null;
            camera.lookAt(to);
            touched = true;
            apply();
          }
        }
        if (glide === null) return;
        const t = (performance.now() - glide.start) / GLIDE_MS;
        camera.lookAt(glideCenter(glide.from, glide.to(), t));
        if (t >= 1) glide = null;
        apply();
      };
      app.ticker.add(onTick);
      cleanups.push(() => app.ticker.remove(onTick));

      // [Q320] Every player whose figure is wholly out of view has a marker
      // just inside the map's edge pointing at it, placed every frame as the
      // map and the figures move. How big a marker is and where the map's
      // buttons are, which they go round, is measured as the map's box changes.
      // They slide a little off what matters on the map (7, 8): the reward
      // icons and guard numbers (Andrei: "the site pictures are eye candy
      // only, it's fone to cover them, but the icons and guard numbers are
      // important"), the figures in view with their rings, and the route,
      // its turn bubbles too (9).
      const labels = scene.labels.map((label) => ({ node: label.node, box: labelBox(label) }));
      let route: { path: PathPreview | null; from: NodeId | null; waypoint: NodeId | null; boxes: readonly Box[] } | null = null;
      const routeNow = (): readonly Box[] => {
        const { path, from, waypoint } = latest.current;
        if (route === null || route.path !== path || route.from !== from || route.waypoint !== waypoint) {
          route = { path, from, waypoint, boxes: routeBoxes(art, gameMap, scene, path, from, waypoint) };
        }
        return route.boxes;
      };
      let arrival: { state: GameState; player: PlayerId; to: NodeId | undefined; standing: readonly { figure: Figure; ring: PlayerRing }[] } | null = null;
      const arrivalNow = (): readonly { figure: Figure; ring: PlayerRing }[] => {
        const { state, walker } = latest.current;
        if (walker === null) return [];
        if (arrival === null || arrival.state !== state || arrival.player !== walker.player || arrival.to !== walker.to) {
          arrival = { state, player: walker.player, to: walker.to, standing: figuresAtWalkEnd(scene, state, art.catalog, walker) };
        }
        return arrival.standing;
      };
      let markerLayout: Omit<EdgeMarkerLayout, 'avoid'> | null = null;
      let markerAcross = 0;
      const placed = new Map<PlayerId, string>();
      const slid = new Map<PlayerId, number>();
      const measureMarkers = (): void => {
        const first = markers.current.values().next().value;
        const controls = buttons.current;
        if (first === undefined || controls === null) {
          markerLayout = null;
          return;
        }
        markerAcross = first.offsetWidth;
        const box = element.getBoundingClientRect();
        const clear = controls.getBoundingClientRect();
        markerLayout = {
          inset: markerAcross / 2 + MARKER.arrow + MARKER.margin,
          spacing: markerAcross + MARKER.gap,
          keepClear: [{ minX: clear.left - box.left, minY: clear.top - box.top, maxX: clear.right - box.left, maxY: clear.bottom - box.top }],
          radius: markerAcross / 2 + MARKER.rim,
          shift: markerAcross,
        };
        setMarkerSize(markerAcross);
      };
      const placeMarkers = (): void => {
        if (markerLayout === null) return;
        const size = viewport();
        const onScreen = (box: Box): Box => {
          const low = planeToScreen(camera.camera, size, { x: box.minX, y: box.minY });
          const high = planeToScreen(camera.camera, size, { x: box.maxX, y: box.maxY });
          return { minX: low.x, minY: low.y, maxX: high.x, maxY: high.y };
        };
        const shows = (box: Box): boolean => box.maxX > 0 && box.minX < size.x && box.maxY > 0 && box.minY < size.y;
        const figures: FigureOnScreen[] = map.characters.flatMap((figure) =>
          figure.player === undefined ? [] : [{ player: figure.player, box: onScreen(pictureBox(figure.foot, figure.size, art.shape(figure.sprite))) }],
        );
        const claimed = map.claimed;
        const wholeZoom = fit().zoom;
        // [Q320, 10] Andrei, 2026-10-26: "it would be ok if a walking figure
        // could go under the floater, as long on its final destination its
        // clear": a walking figure and its ring are not kept off, and (11) as
        // the walk starts markers make room where it will stand at its end,
        // with whoever stands beside it there.
        const standing = [
          ...map.characters.flatMap((figure, index) => (figure.walking ? [] : [{ figure, ring: map.rings[index] }])),
          ...arrivalNow(),
        ];
        const avoid = [
          ...labels.flatMap((label) => (claimed.has(label.node) ? [] : [label.box])),
          ...standing.map(({ figure }) => pictureBox(figure.foot, figure.size, art.shape(figure.sprite))),
          ...standing.flatMap(({ ring }) => (ring === undefined ? [] : [groundBox(scene, ring.at, playerRingSize(ring.size, scene.spacing, camera.camera.zoom, wholeZoom) / 2)])),
          ...routeNow(),
          ...map.turnBubbles,
        ]
          .map(onScreen)
          .filter(shows);
        const shown = edgeMarkers(size, figures, { ...markerLayout, avoid }, slid);
        slid.clear();
        for (const one of shown) slid.set(one.player, one.shift);
        for (const [player, marker] of markers.current) {
          const one = shown.find((candidate) => candidate.player === player);
          const transform = one === undefined ? null : `translate(${(one.at.x - markerAcross / 2).toFixed(1)}px, ${(one.at.y - markerAcross / 2).toFixed(1)}px)`;
          const angle = one === undefined ? null : `${one.angle.toFixed(3)}rad`;
          const place = `${transform} ${angle}`;
          if (placed.get(player) === place) continue;
          placed.set(player, place);
          marker.style.visibility = transform === null ? 'hidden' : 'visible';
          if (transform !== null) marker.style.transform = transform;
          if (angle !== null) marker.style.setProperty('--angle', angle);
        }
      };
      measureMarkers();
      app.ticker.add(placeMarkers);
      cleanups.push(() => app.ticker.remove(placeMarkers));

      // Pixi's `resizeTo` follows the window only, and on a phone the map's
      // box also changes as the panels round it do, so resize the canvas here.
      const reframe = (): void => {
        camera.setFit(fit(), viewport());
        if (!touched) camera.resetToFit();
        apply();
      };
      const observer = new ResizeObserver(() => {
        app.resize();
        reframe();
        measureMarkers();
      });
      observer.observe(element);
      // The map's buttons change as Track comes and goes.
      if (buttons.current !== null) observer.observe(buttons.current);
      refit.current = reframe;
      cleanups.push(() => {
        observer.disconnect();
        refit.current = null;
      });

      // Pointer drags pan; two pointers pinch; the wheel and +/- zoom; a press
      // that hardly moves is a click on whatever is under it.
      const pointers = new Map<number, Point>();
      let press: { id: number; at: Point; travel: number; lone: boolean } | null = null;
      const local = (event: PointerEvent | WheelEvent): Point => {
        const box = element.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
      };
      const onDown = (event: PointerEvent): void => {
        // A press stops the glide; only an actual drag or pinch counts as
        // moving the map, which stops the following too.
        glide = null;
        aims.current++;
        element.setPointerCapture(event.pointerId);
        const at = local(event);
        pointers.set(event.pointerId, at);
        press = pointers.size === 1 ? { id: event.pointerId, at, travel: 0, lone: true } : press === null ? null : { ...press, lone: false };
      };
      const onMove = (event: PointerEvent): void => {
        const before = pointers.get(event.pointerId);
        if (before === undefined) return;
        const now = local(event);
        if (press !== null && press.id === event.pointerId) {
          press = { ...press, travel: Math.max(press.travel, Math.hypot(now.x - press.at.x, now.y - press.at.y)) };
        }
        if (pointers.size === 1) {
          // Not a drag yet; once it is, the pan takes in the whole way from the press.
          if (press !== null && press.travel < TAP_TRAVEL_PX) return;
          camera.pan({ from: before, to: now });
        } else if (pointers.size === 2) {
          const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other !== undefined) {
            const was = Math.hypot(before.x - other.x, before.y - other.y);
            const is = Math.hypot(now.x - other.x, now.y - other.y);
            if (was > 0) camera.zoomAt({ x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 }, is / was);
          }
        }
        pointers.set(event.pointerId, now);
        moved();
        touched = true;
        apply();
      };
      const onUp = (event: PointerEvent): void => {
        pointers.delete(event.pointerId);
        const released = press;
        if (released === null || released.id !== event.pointerId) return;
        press = null;
        if (event.type !== 'pointerup' || !released.lone || released.travel >= TAP_TRAVEL_PX) return;
        const tap = latest.current.onTap;
        if (tap === undefined) return;
        const plane = screenToPlane(camera.camera, viewport(), local(event));
        const pictures = scene.billboards.filter((item) => item.layer === 'pois');
        tap(pick(scene, gameMap, map.characters, pictures, art.shape, plane, camera.camera.zoom), event.shiftKey);
      };
      const onWheel = (event: WheelEvent): void => {
        event.preventDefault();
        moved();
        camera.zoomAt(local(event), Math.exp(-event.deltaY * 0.0015));
        touched = true;
        apply();
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.key === '+' || event.key === '=') camera.zoomIn();
        else if (event.key === '-' || event.key === '_') camera.zoomOut();
        else return;
        moved();
        touched = true;
        apply();
      };
      element.addEventListener('pointerdown', onDown);
      element.addEventListener('pointermove', onMove);
      element.addEventListener('pointerup', onUp);
      element.addEventListener('pointercancel', onUp);
      element.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKey);
      cleanups.push(() => {
        element.removeEventListener('pointerdown', onDown);
        element.removeEventListener('pointermove', onMove);
        element.removeEventListener('pointerup', onUp);
        element.removeEventListener('pointercancel', onUp);
        element.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
      });

      zoomButtons.current = (action) => {
        moved();
        if (action === 'in') camera.zoomIn();
        else if (action === 'out') camera.zoomOut();
        else camera.resetToFit();
        touched = action !== 'fit';
        apply();
      };

      const planeOf = (node: NodeId): Point => scene.projection.toScreen(position(gameMap.graph, node));
      const centerAt = (plane: Point): void => {
        halt();
        camera.centerOn(plane, fit().zoom * PLAY_ZOOM_OF_FIT * playZoomScale(gameMap));
        touched = true;
        apply();
      };
      latest.current.onReady?.({
        screenOf: (node) => planeToScreen(camera.camera, viewport(), planeOf(node)),
        screenOfFigure: (player) => {
          const top = figureTop(map.characters, art.shape, player);
          return top === null ? null : planeToScreen(camera.camera, viewport(), top);
        },
        centerOnFigure: (player) => {
          const walking = latest.current.walker;
          if (walking !== null && walking.player === player) return centerAt(scene.projection.toScreen(walking.at));
          const stands = latest.current.state.players.find((one) => one.id === player);
          if (stands !== undefined) centerAt(planeOf(stands.position));
        },
        glideTo: (node) => {
          const to = planeOf(node);
          const from = camera.camera.center;
          const there = Math.hypot(to.x - from.x, to.y - from.y) * camera.camera.zoom < 1;
          glide = there ? null : { from, to: () => to, start: performance.now(), chasing: false };
          touched = true;
          aims.current++;
        },
        gliding: () => glide !== null,
        track: (node) => {
          following.current = true;
          aims.current++;
          const walking = latest.current.walker;
          if (walking !== null) {
            // Wherever the figure has got to; once its walk is over, the node it stands on.
            const to = (): Point => {
              const now = latest.current.walker;
              if (now !== null && now.player === walking.player) return scene.projection.toScreen(now.at);
              const stands = latest.current.state.players.find((player) => player.id === walking.player);
              return stands === undefined ? scene.projection.toScreen(walking.at) : planeOf(stands.position);
            };
            glide = { from: camera.camera.center, to, start: performance.now(), chasing: true };
          } else if (node !== null) {
            const to = planeOf(node);
            glide = { from: camera.camera.center, to: () => to, start: performance.now(), chasing: false };
          }
          touched = true;
        },
        followMark: () => (following.current ? aims.current : null),
        makeRoom: (box, mark) => {
          if (mark !== aims.current) return;
          const to = roomFor(camera.camera, viewport(), box, ROOM_MARGIN_PX);
          if (to.x === camera.camera.center.x && to.y === camera.camera.center.y) return;
          glide = { from: camera.camera.center, to: () => to, start: performance.now(), chasing: true };
          touched = true;
        },
      });
    }

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      latest.current.onReady?.(null);
      renderer.current = null;
      zoomButtons.current = null;
      try {
        if (app.renderer !== undefined) app.destroy(true, { children: true });
      } catch {
        // A map that failed half way through starting may not come apart cleanly; a new one is built regardless.
      }
    };
  }, [art, gameMap, scene, build, broken]);

  useEffect(() => {
    renderer.current?.setState(state);
  }, [state]);
  useEffect(() => {
    renderer.current?.setWalker(walker);
  }, [walker]);
  useEffect(() => {
    renderer.current?.setPathPreview(path, from, turnStops);
  }, [path, from, turnStops]);
  useEffect(() => {
    renderer.current?.setWaypoint(waypoint);
  }, [waypoint]);
  useEffect(() => {
    renderer.current?.setCue(cue);
  }, [cue]);
  useEffect(() => {
    renderer.current?.setPlanner(planner);
  }, [planner]);
  useEffect(() => {
    renderer.current?.setFound(found);
  }, [found]);
  useEffect(() => {
    following.current = follow;
  }, [follow]);
  useEffect(() => {
    refit.current?.();
  }, [frame]);

  return (
    <>
      <div ref={sky} className="map-sky" />
      <div ref={host} className="canvas-host" aria-label="The map" role="img" />
      {broken ? (
        // [Q86, 331] The map could not be built, even after trying again.
        <div className="overlay map-trouble" role="alert">
          <p>The map could not be drawn. Reload the page to try again.</p>
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}
      {onFind === undefined ? null : (
        // [Q320] Placed by the map every frame; hidden while their figure shows.
        <div className="overlay edge-markers">
          {state.players.map((player) => (
            <button
              key={player.id}
              className="edge-marker"
              type="button"
              aria-label={`Find ${player.name} on the map`}
              style={{ visibility: 'hidden' }}
              onClick={() => onFind(player.id)}
              ref={(element) => {
                if (element === null) markers.current.delete(player.id);
                else markers.current.set(player.id, element);
              }}
            >
              <span className="edge-arrow" />
              <span className="edge-face">
                <Portrait catalog={art.catalog} avatarId={player.avatarId} size={markerSize} label={`${player.name}’s avatar`} />
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="overlay zoom" ref={buttons}>
        {/* [Q63, 139] Pressed while sound is on, as Track is while it follows.
            [170 and 171] A speaker instead of the word: sound waves while on, a cross while off. */}
        {sound === undefined ? null : (
          <button className="btn icon" type="button" aria-label="Sound" aria-pressed={sound.on} onClick={sound.onToggle}>
            <Speaker on={sound.on} />
          </button>
        )}
        {onTrack === undefined ? null : (
          <button className="btn" type="button" aria-pressed={tracking} onClick={onTrack}>
            Track
          </button>
        )}
        <button className="btn" type="button" aria-label="Zoom in" onClick={() => zoomButtons.current?.('in')}>
          +
        </button>
        <button className="btn" type="button" aria-label="Zoom out" onClick={() => zoomButtons.current?.('out')}>
          −
        </button>
        <button className="btn" type="button" onClick={() => zoomButtons.current?.('fit')}>
          Whole map
        </button>
      </div>
    </>
  );
}

/**
 * [Q320, 8] What the route drawn covers, at zoom 1: each of its dots, the
 * cross at its end and the waypoint's flag.
 */
function routeBoxes(art: LoadedArt, map: GameMap, scene: MapScene, path: PathPreview | null, from: NodeId | null, waypoint: NodeId | null): Box[] {
  const boxes: Box[] = [];
  if (path !== null && from !== null) {
    const drawn = buildPathScene(scene, map, from, path, art.catalog);
    for (const mark of [...drawn.dots, drawn.cross]) boxes.push(groundBox(scene, mark.at, mark.size / 2));
  }
  if (waypoint !== null) {
    const flag = buildWaypoint(scene, map, waypoint, art.catalog);
    boxes.push(pictureBox(flag.foot, flag.size, art.shape(flag.sprite)));
  }
  return boxes;
}

/** The box round a circle on the ground, its middle and radius in world units, at zoom 1. */
function groundBox(scene: MapScene, at: Point, radius: number): Box {
  const { a, b, c, d } = scene.projection.matrix;
  const middle = scene.projection.toScreen(at);
  const wide = radius * Math.hypot(a, c);
  const high = radius * Math.hypot(b, d);
  return { minX: middle.x - wide, minY: middle.y - high, maxX: middle.x + wide, maxY: middle.y + high };
}

/** Whether the map's WebGL drawing surface is lost; never for a map drawn without WebGL. */
function surfaceLost(app: Application): boolean {
  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
  return gl !== undefined && gl.isContextLost();
}

/**
 * [Andrei, 2026-09-28] "Can the "Sound" button use a volume / speaker icon"
 * (Q63, 170): a speaker drawn here rather than a font's or the device's
 * symbol, so it looks the same everywhere, in the colour of the button's words.
 */
function Speaker({ on }: { readonly on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5h3.5L11.5 5v14l-5-4.5H3z" fill="currentColor" />
      {on ? (
        <>
          <path d="M15 9a4.2 4.2 0 0 1 0 6" />
          <path d="M18 6a8.5 8.5 0 0 1 0 12" />
        </>
      ) : (
        <>
          <path d="M15.5 9.5l5 5" />
          <path d="M20.5 9.5l-5 5" />
        </>
      )}
    </svg>
  );
}
