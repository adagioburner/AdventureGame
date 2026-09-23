import { TERRAINS } from '@adventure/config';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';

interface ArtPanelProps {
  readonly catalog: ArtCatalog;
  readonly onClose: () => void;
}

interface Row {
  readonly what: string;
  readonly file: string;
  readonly tag: 'placeholder' | 'borrowed' | 'supplied';
  readonly note?: string;
}

const TERRAIN_NAMES = { plains: 'Plains', forest: 'Forest', mountain: 'Mountain' } as const;
const REWARD_NAMES = {
  plains_move: 'plains movement',
  forest_move: 'forest movement',
  mountain_move: 'mountain movement',
  fighting: 'fighting',
  magic: 'magic',
  gold: 'gold',
  stamina: 'stamina',
} as const;

/**
 * Every picture the map uses and where it comes from, straight from
 * `Art/manifest.json` and the atlases' `placeholder` flags — so what still
 * needs real art, and which rows borrow another row's sheet, can be read off
 * the page rather than out of the repository.
 */
export function ArtPanel({ catalog, onClose }: ArtPanelProps) {
  const { manifest } = catalog;
  const tagOf = (sheet: string): Row['tag'] => (atlasOf(catalog, sheet).placeholder ? 'placeholder' : 'supplied');

  const ground: Row[] = TERRAINS.flatMap((terrain) => {
    const art = manifest.terrain[terrain];
    return [
      { what: `${TERRAIN_NAMES[terrain]} texture`, file: art.texture, tag: tagOf(art.texture) },
      ...art.dressing.map((dressing) => ({
        what: `${TERRAIN_NAMES[terrain]} dressing`,
        file: dressing.sheet,
        tag: tagOf(dressing.sheet),
      })),
    ];
  });
  ground.push({ what: 'Roads', file: `${manifest.roads.sheet} · ${manifest.roads.sprite}`, tag: tagOf(manifest.roads.sheet) });

  const pois: Row[] = manifest.pois.map((row) => {
    const where = row.terrain === 'any' ? 'Any terrain' : TERRAIN_NAMES[row.terrain];
    const guard = row.guard === null ? '' : `, ${row.guard} guard`;
    return {
      what: `${where}: ${REWARD_NAMES[row.reward]}${guard}`,
      file: row.sheet,
      tag: row.borrowed !== null ? 'borrowed' : tagOf(row.sheet),
      ...(row.borrowed !== null ? { note: row.borrowed } : {}),
    };
  });

  const rest: Row[] = [
    { what: 'Move markers', file: manifest.moveProspect.sheet, tag: tagOf(manifest.moveProspect.sheet) },
    { what: 'Player figurines', file: manifest.figurines.sheet, tag: tagOf(manifest.figurines.sheet) },
    { what: 'Die roll', file: manifest.dice.sheet, tag: tagOf(manifest.dice.sheet) },
    { what: 'Reward icons', file: 'Icons/<reward>.png', tag: 'supplied' },
  ];

  return (
    <aside className="art" aria-label="Art in use">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
        <h2>Art in use</h2>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        Every picture comes from one table, Art/manifest.json. Placeholders were generated to stand in until real art
        arrives; borrowed rows use another row’s sheet for now.
      </p>
      <Section title="Ground" rows={ground} />
      <Section title="Points of interest" rows={pois} />
      <Section title="Players and markers" rows={rest} />
    </aside>
  );
}

function Section({ title, rows }: { readonly title: string; readonly rows: readonly Row[] }) {
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => (
          <li key={`${row.what}-${row.file}`} title={row.note}>
            <span>{row.what}</span>
            <span className={`tag ${row.tag}`}>{row.tag}</span>
            <code>{row.file}</code>
          </li>
        ))}
      </ul>
    </>
  );
}
