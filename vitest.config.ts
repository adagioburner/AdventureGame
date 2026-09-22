import { defineConfig } from 'vitest/config';

/**
 * The test harness. [SOURCE docs/IMPLEMENTATION_PLAN.md phase 0] — Vitest was
 * chosen in `docs/STACK.md` §3; this is the first change that installs it.
 *
 * Like `packages/core/src/rng.ts`, this file is infrastructure rather than game
 * design, so it carries no GDD provenance tags.
 */
export default defineConfig({
  test: {
    // Tests live next to the module they cover, inside each package's `src/`,
    // so they import through the same relative `.ts` paths the modules already
    // use and need no build step and no second tsconfig. `tsconfig.json`
    // already includes `packages/*/src/**/*.ts`, so `pnpm run typecheck` checks
    // the tests too.
    include: ['{packages,apps,tools}/*/src/**/*.test.ts'],

    // No `globals: true`. Tests import `describe`/`it`/`expect` explicitly,
    // which keeps `verbatimModuleSyntax` happy and means the typecheck needs no
    // ambient types added to `tsconfig.base.json`.
    globals: false,
    environment: 'node',
  },
});
