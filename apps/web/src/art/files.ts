import type { ArtFiles } from './catalog.ts';

/**
 * `Art/` as the bundler sees it: every JSON file parsed, every PNG as a URL.
 *
 * This is the only module that knows where `Art/` sits relative to the client,
 * and it names no individual file — `Art/manifest.json` does that. Dropping a
 * new `<Name>_sheet.png` and `<Name>_atlas.json` into the folder is enough for
 * them to be bundled; naming them in the manifest is what puts them on screen.
 */
const ART_DIR = '../../../../Art/';

const json = import.meta.glob<unknown>(['../../../../Art/*.json', '../../../../Art/Icons/*.json'], {
  import: 'default',
  eager: true,
});
const urls = import.meta.glob<string>(['../../../../Art/*.png', '../../../../Art/Icons/*.png'], {
  query: '?url',
  import: 'default',
  eager: true,
});

function underArt<T>(files: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(files).map(([path, value]) => [path.slice(ART_DIR.length), value]));
}

export const ART_FILES: ArtFiles = { json: underArt(json), urls: underArt(urls) };
