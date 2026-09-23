import { defineConfig } from 'vite';

/**
 * The client's dev server and build (docs/STACK.md §3).
 *
 * `Art/` sits at the repository root, outside this app, and is bundled from
 * there by `src/art/files.ts`, so the dev server is allowed to read the whole
 * repository. `base: './'` makes every URL in the build relative, so the built
 * page runs from any folder — a static host, or a preview posted for review.
 */
export default defineConfig({
  base: './',
  server: { fs: { allow: ['../..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
});
