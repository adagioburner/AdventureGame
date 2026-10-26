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
import { figureTop, pick, planeToScreen, screenToPlane, type Pick } from '../interaction/picking.ts';
import { fitToViewport, type Camera } from '../render/isometric.ts';
import { position } from '../render/geometry.ts';
import { undersideDepth } from '../render/island.ts';
import { PixiMapRenderer } from '../render/pixi/renderer.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import { SPACING_PX, type FigureCue, type MapScene, type Walker } from '../render/sceneModel.ts';
import { MAP_RESTORE_WAIT_MS, MAP_RETRY_MS, noteMapTrouble } from './mapTrouble.ts';
import { skyScale } from './sky.ts';

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
   * and so does a walk that has to take the map along (Q47).
   */
  glideTo(node: NodeId): void;
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
  readonly waypoint: NodeId | null;
  readonly walker: Walker | null;
  /** How the current player's figure calls attention to itself; `none` if omitted. */
  readonly cue?: FigureCue;
  /** [Q56, 49] Online, the player planning out of turn, whose figure is highlighted. */
  readonly planner?: PlayerId | null;
  /** [Q120, 471] The player whose card was just clicked, whose figure is highlighted for a moment. */
  readonly found?: PlayerId | null;
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
  waypoint,
  walker,
  cue = 'none',
  planner = null,
  found = null,
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
  // Read when the renderer comes up, and by the pointer handlers, which are
  // bound once per map.
  const from = pathFrom ?? state.players[state.turn.activeSeat - 1]?.position ?? null;
  const latest = useRef({ state, path, from, waypoint, walker, cue, planner, found, keepFollowing, onTap, onMoved, onReady });
  latest.current = { state, path, from, waypoint, walker, cue, planner, found, keepFollowing, onTap, onMoved, onReady };
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
      map.setPathPreview(now.path, now.from);
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
      });
      observer.observe(element);
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
          glide = { from: camera.camera.center, to: () => to, start: performance.now(), chasing: false };
          touched = true;
          aims.current++;
        },
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
    renderer.current?.setPathPreview(path, from);
  }, [path, from]);
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
      <div className="overlay zoom">
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
