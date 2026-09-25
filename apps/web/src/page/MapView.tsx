import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import type { GameMap, GameState, NodeId, PathPreview, PlayerId, Point } from '@adventure/core';
import { createCameraController, FOLLOW_MARGIN_OF_VIEW, followInto, glideCenter, GLIDE_MS, type CameraController } from '../interaction/camera.ts';
import { figureTop, pick, planeToScreen, screenToPlane, type Pick } from '../interaction/picking.ts';
import { fitToViewport } from '../render/isometric.ts';
import { position } from '../render/geometry.ts';
import { PixiMapRenderer } from '../render/pixi/renderer.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import { SPACING_PX, type FigureCue, type MapScene, type Walker } from '../render/sceneModel.ts';

/** What the page can ask of the map once it is up. */
export interface MapHandle {
  /** Where a node shows in the map's box, in CSS pixels. */
  screenOf(node: NodeId): Point;
  /** Where the top of a player's figure shows in the map's box, as it is drawn right now. */
  screenOfFigure(player: PlayerId): Point | null;
  /** Bring a node to the middle, zoomed in enough to play at. */
  centerOn(node: NodeId): void;
  /**
   * Slide a node to the middle over `GLIDE_MS`, at the zoom the view already
   * has. Panning, zooming or `centerOn` while it slides stops it where it is,
   * and so does a walk that has to take the map along (Q47).
   */
  glideTo(node: NodeId): void;
  /**
   * [Q57, 74] Track was pressed: glide to the figure that is walking, if one
   * is, or else to `node`, and follow walks from now on.
   */
  track(node: NodeId | null): void;
}

interface MapViewProps {
  readonly art: LoadedArt;
  readonly map: GameMap;
  /** `buildMapScene` of `map`: built once per map by the page, not per render. */
  readonly scene: MapScene;
  readonly state: GameState;
  /** §7.1's dotted route and cross, from the current player's node. */
  readonly path: PathPreview | null;
  readonly waypoint: NodeId | null;
  readonly walker: Walker | null;
  /** How the current player's figure calls attention to itself; `none` if omitted. */
  readonly cue?: FigureCue;
  /** [Q56, 49] Online, the player planning out of turn, whose figure is highlighted. */
  readonly planner?: PlayerId | null;
  /** A click or tap, as opposed to a drag; `shift` for a shift-click. */
  readonly onTap?: (target: Pick, shift: boolean) => void;
  /**
   * [Q57] Whether Track is pressed: a walking figure takes the map along only
   * while it is (Q47). Pressed if omitted.
   */
  readonly tracking?: boolean;
  /** [Q57, 72] Shows the Track button, above "+", which calls this. */
  readonly onTrack?: (() => void) | undefined;
  /** [Q57, 73] The viewer dragged, pinched or zoomed the map, or pressed "+", "−" or "Whole map". */
  readonly onMoved?: () => void;
  readonly onReady?: (handle: MapHandle | null) => void;
}

/** Room above, beside and below the ground that pictures on the edge nodes stand in. */
const OVERHANG = { top: SPACING_PX * 1.2, side: SPACING_PX * 0.5, bottom: SPACING_PX * 0.5 };

/** A press that travels less than this, in CSS pixels, is a click rather than a drag. */
const TAP_TRAVEL_PX = 8;

/** Zoom, relative to the whole-map view, that "find" brings the map to at least. */
const PLAY_ZOOM_OF_FIT = 2.2;

export function MapView({
  art,
  map: gameMap,
  scene,
  state,
  path,
  waypoint,
  walker,
  cue = 'none',
  planner = null,
  onTap,
  tracking = true,
  onTrack,
  onMoved,
  onReady,
}: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<PixiMapRenderer | null>(null);
  const zoomButtons = useRef<((action: 'in' | 'out' | 'fit') => void) | null>(null);
  // Read when the renderer comes up, and by the pointer handlers, which are
  // bound once per map.
  const latest = useRef({ state, path, waypoint, walker, cue, planner, onTap, onMoved, onReady });
  latest.current = { state, path, waypoint, walker, cue, planner, onTap, onMoved, onReady };
  // Whether a walk takes the map along. It follows Track, and stops at once
  // when the map is moved, before the page has unpressed Track.
  const following = useRef(tracking);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let disposed = false;
    const app = new Application();
    const cleanups: (() => void)[] = [];

    void (async () => {
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
      element.appendChild(app.canvas);

      const map = new PixiMapRenderer(art, gameMap, scene);
      const now = latest.current;
      map.setWalker(now.walker);
      map.setPlanner(now.planner);
      map.setState(now.state);
      map.setPathPreview(now.path);
      map.setWaypoint(now.waypoint);
      map.setCue(now.cue);
      app.stage.addChild(map.root);
      app.ticker.add(() => map.tick(performance.now()));
      renderer.current = map;

      const viewport = (): Point => ({ x: element.clientWidth, y: element.clientHeight });
      const fit = () => fitToViewport(scene.projection, scene.bounds, viewport(), OVERHANG);
      const camera: CameraController = createCameraController(fit(), viewport());
      let touched = false;
      const apply = (): void => {
        map.setViewport(viewport());
        map.setCamera(camera.camera);
      };
      apply();

      // `chasing` for Track's glide to a walking figure, which the walk's
      // own following waits for; it aims at wherever the figure is by then.
      let glide: { from: Point; to: () => Point; start: number; chasing: boolean } | null = null;
      // [Andrei, 2026-09-24] Q47: a walking figure that nears the edge of the
      // view takes the map along with it; since Q57, while Track is pressed.
      const stopCamera = (): void => {
        glide = null;
        following.current = false;
      };
      /** The viewer moved the map: [Q57, 73] Track unpresses. */
      const moved = (): void => {
        stopCamera();
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

      // Pixi's `resizeTo` follows the window only, and on a phone the map's
      // box also changes as the panels round it do, so resize the canvas here.
      const observer = new ResizeObserver(() => {
        app.resize();
        camera.setFit(fit(), viewport());
        if (!touched) camera.resetToFit();
        apply();
      });
      observer.observe(element);
      cleanups.push(() => observer.disconnect());

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
      latest.current.onReady?.({
        screenOf: (node) => planeToScreen(camera.camera, viewport(), planeOf(node)),
        screenOfFigure: (player) => {
          const top = figureTop(map.characters, art.shape, player);
          return top === null ? null : planeToScreen(camera.camera, viewport(), top);
        },
        centerOn: (node) => {
          stopCamera();
          camera.centerOn(planeOf(node), fit().zoom * PLAY_ZOOM_OF_FIT);
          touched = true;
          apply();
        },
        glideTo: (node) => {
          const to = planeOf(node);
          glide = { from: camera.camera.center, to: () => to, start: performance.now(), chasing: false };
          touched = true;
        },
        track: (node) => {
          following.current = true;
          const walking = latest.current.walker;
          if (walking !== null) {
            let last = walking.at;
            const to = (): Point => {
              last = latest.current.walker?.at ?? last;
              return scene.projection.toScreen(last);
            };
            glide = { from: camera.camera.center, to, start: performance.now(), chasing: true };
          } else if (node !== null) {
            const to = planeOf(node);
            glide = { from: camera.camera.center, to: () => to, start: performance.now(), chasing: false };
          }
          touched = true;
        },
      });
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      latest.current.onReady?.(null);
      renderer.current = null;
      zoomButtons.current = null;
      if (app.renderer !== undefined) app.destroy(true, { children: true });
    };
  }, [art, gameMap, scene]);

  useEffect(() => {
    renderer.current?.setState(state);
  }, [state]);
  useEffect(() => {
    renderer.current?.setWalker(walker);
  }, [walker]);
  useEffect(() => {
    renderer.current?.setPathPreview(path);
  }, [path]);
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
    following.current = tracking;
  }, [tracking]);

  return (
    <>
      <div ref={host} className="canvas-host" aria-label="The map" role="img" />
      <div className="overlay zoom">
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
