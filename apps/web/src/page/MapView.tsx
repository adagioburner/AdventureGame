import { useEffect, useRef } from 'react';
import { Application } from 'pixi.js';
import type { Point } from '@adventure/core';
import { createCameraController, type CameraController } from '../interaction/camera.ts';
import { fitToViewport } from '../render/isometric.ts';
import { PixiMapRenderer } from '../render/pixi/renderer.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import { buildMapScene, SPACING_PX } from '../render/sceneModel.ts';
import type { PreviewGame, SampleMove } from './preview.ts';

interface MapViewProps {
  readonly art: LoadedArt;
  readonly game: PreviewGame;
  readonly showSample: boolean;
}

/** Room above, beside and below the ground that pictures on the edge nodes stand in. */
const OVERHANG = { top: SPACING_PX * 1.2, side: SPACING_PX * 0.5, bottom: SPACING_PX * 0.5 };

export function MapView({ art, game, showSample }: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<PixiMapRenderer | null>(null);
  const controller = useRef<CameraController | null>(null);
  const zoomButtons = useRef<((action: 'in' | 'out' | 'fit') => void) | null>(null);
  // Read when the renderer comes up, which happens after this render.
  const sampleShown = useRef(showSample);
  sampleShown.current = showSample;

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

      const scene = buildMapScene(game.map, art.catalog);
      const map = new PixiMapRenderer(art, game.map, scene);
      map.setState(game.state);
      showSampleOn(map, sampleShown.current ? game.sample : null);
      app.stage.addChild(map.root);
      renderer.current = map;

      const viewport = (): Point => ({ x: element.clientWidth, y: element.clientHeight });
      const fit = () => fitToViewport(scene.projection, scene.bounds, viewport(), OVERHANG);
      const camera = createCameraController(fit(), viewport());
      controller.current = camera;
      let touched = false;
      const apply = (): void => {
        map.setViewport(viewport());
        map.setCamera(camera.camera);
      };
      apply();

      const observer = new ResizeObserver(() => {
        camera.setFit(fit(), viewport());
        if (!touched) camera.resetToFit();
        apply();
      });
      observer.observe(element);
      cleanups.push(() => observer.disconnect());

      // Pointer drags pan; two pointers pinch; the wheel and +/- zoom.
      const pointers = new Map<number, Point>();
      const local = (event: PointerEvent | WheelEvent): Point => {
        const box = element.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
      };
      const onDown = (event: PointerEvent): void => {
        element.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, local(event));
      };
      const onMove = (event: PointerEvent): void => {
        const before = pointers.get(event.pointerId);
        if (before === undefined) return;
        const now = local(event);
        if (pointers.size === 1) {
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
        touched = true;
        apply();
      };
      const onUp = (event: PointerEvent): void => {
        pointers.delete(event.pointerId);
      };
      const onWheel = (event: WheelEvent): void => {
        event.preventDefault();
        camera.zoomAt(local(event), Math.exp(-event.deltaY * 0.0015));
        touched = true;
        apply();
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.key === '+' || event.key === '=') camera.zoomIn();
        else if (event.key === '-' || event.key === '_') camera.zoomOut();
        else return;
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

      const buttons = (action: 'in' | 'out' | 'fit'): void => {
        if (action === 'in') camera.zoomIn();
        else if (action === 'out') camera.zoomOut();
        else camera.resetToFit();
        touched = action !== 'fit';
        apply();
      };
      zoomButtons.current = buttons;
    })();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      renderer.current = null;
      controller.current = null;
      zoomButtons.current = null;
      if (app.renderer !== undefined) app.destroy(true, { children: true });
    };
  }, [art, game]);

  useEffect(() => {
    if (renderer.current !== null) showSampleOn(renderer.current, showSample ? game.sample : null);
  }, [game, showSample]);

  const sample = game.sample;
  return (
    <>
      <div ref={host} className="canvas-host" aria-label="The map, drawn as a player sees it" role="img" />
      <div className="overlay zoom">
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
      {showSample && sample !== null ? (
        <div className="overlay legend">
          <p>
            Sample route for a player with {sample.stamina} stamina, plains-move {sample.allowance.plains} and
            forest-move {sample.allowance.forest} (the rules’ worked example). The flag is a waypoint.
          </p>
          <div className="chips">
            <span className="chip">
              <i style={{ background: 'var(--free)' }} />
              Free with skill
            </span>
            <span className="chip">
              <i style={{ background: 'var(--stamina)' }} />
              Costs stamina
            </span>
            <span className="chip">
              <i style={{ background: 'var(--unreachable)' }} />
              Out of reach this turn
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function showSampleOn(map: PixiMapRenderer, sample: SampleMove | null): void {
  map.setPathPreview(sample?.preview ?? null);
  map.setWaypoint(sample?.waypoint ?? null);
}
