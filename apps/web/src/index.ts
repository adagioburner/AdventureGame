/**
 * `@adventure/web` — the client.
 *
 * PixiJS draws the isometric map and ordinary React DOM carries the page
 * around it (see `docs/ARCHITECTURE.md` §9). The page's entry point is
 * `main.tsx`; this module is the seam other code types against.
 *
 * The rule that matters more than the framework choice: **the client computes
 * no rules of its own.** Path costs, allowance accounting, reachability colours
 * and the win condition all come from `@adventure/core`, the same module the
 * server runs.
 */
export * from './art/atlas.ts';
export * from './art/manifest.ts';
export * from './art/catalog.ts';
export * from './render/isometric.ts';
export * from './render/scene.ts';
export * from './render/sceneModel.ts';
export * from './interaction/camera.ts';
export * from './interaction/moveMode.ts';
export * from './state/client.ts';
export * from './modes/online.ts';
export * from './modes/hotseat.ts';
