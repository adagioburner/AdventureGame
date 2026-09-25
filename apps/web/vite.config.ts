import { defineConfig } from 'vite';

/**
 * The client's dev server and build (docs/STACK.md §3).
 *
 * `Art/` sits at the repository root, outside this app, and is bundled from
 * there by `src/art/files.ts`, so the dev server is allowed to read the whole
 * repository. `base: './'` makes every URL in the build relative, so the built
 * page runs from any folder — a static host, or a preview posted for review.
 *
 * `--mode site` builds the online site instead (`src/online/`), into
 * `dist-site/`, which the Worker in `apps/server` serves. Its pages have
 * addresses such as `/games/<id>`, so its URLs start at the root instead; its
 * dev server passes `/api` to `wrangler dev` on port 8787.
 */
export default defineConfig(({ mode }) => {
  const site = mode === 'site';
  return {
    base: site ? '/' : './',
    server: {
      fs: { allow: ['../..'] },
      ...(site ? { proxy: { '/api': { target: 'http://localhost:8787', ws: true } } } : {}),
    },
    build: {
      outDir: site ? 'dist-site' : 'dist',
      emptyOutDir: true,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 2000,
    },
  };
});
