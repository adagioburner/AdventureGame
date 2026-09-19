/**
 * `@adventure/web` — the client.
 *
 * Boundaries only in this pass: no framework is committed to in code. The
 * proposed split (see `docs/ARCHITECTURE.md`) is a canvas/WebGL scene graph for
 * the isometric map and ordinary DOM for the HUD, message board and setup
 * screens, with these interfaces as the seam between them.
 *
 * The rule that matters more than the framework choice: **the client computes
 * no rules of its own.** Path costs, allowance accounting, reachability colours
 * and the win condition all come from `@adventure/core`, the same module the
 * server runs.
 */
export * from './render/isometric.ts';
export * from './render/scene.ts';
export * from './interaction/camera.ts';
export * from './interaction/moveMode.ts';
export * from './state/client.ts';
export * from './modes/online.ts';
export * from './modes/hotseat.ts';
