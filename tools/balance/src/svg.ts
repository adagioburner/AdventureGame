import { TERRAINS, type Terrain } from '@adventure/config';
import { isLeaf, poiAt, type GameMap, type NodeId, type Poi } from '@adventure/core';

/**
 * The diagnostic map dump — GDD step 1 asks for output "viewable by humans
 * (pdf, svg or similar)", and this is it.
 *
 * **This drawing is a developer tool and never becomes the game's map.** It
 * exists to answer "did generation do what §2.1 says", so it deliberately shows
 * the generator's internals: remoteness above all, which decides §4.3's rewards
 * and §5.2's guards and which a *player* must never see. It lives in
 * `tools/balance` rather than `apps/web` so it cannot drift into the client.
 * The map players look at is drawn in phase 3 and shares nothing with this but
 * the `GameMap` it reads. See `docs/ARCHITECTURE.md` §9.
 *
 * Top-down, not isometric, for the same reason: the point is to inspect the
 * graph, not to preview the game.
 */
export interface MapSvgOptions {
  /** Nodes converted by §2.1 step 6, which the sealed `GameMap` does not carry. */
  readonly valleyNodes?: readonly NodeId[];
}

const TERRAIN_FILL: Record<Terrain, string> = {
  plains: '#d8c08a',
  forest: '#5d8f57',
  mountain: '#9a9aa4',
};

/** §4.1's seven kinds, shortened to fit inside a node. */
const KIND_LABEL: Record<string, string> = {
  plains_move: 'P',
  forest_move: 'F',
  mountain_move: 'M',
  fighting: 'Fi',
  magic: 'Mg',
  gold: 'G',
  stamina: 'St',
};

const GUARD_COLOR: Record<string, string> = { fighting: '#c0392b', magic: '#8e44ad' };

export function renderMapSvg(map: GameMap, options: MapSvgOptions = {}): string {
  const space = map.ruleset.config.map.MAP_COORDINATE_SPACE;
  const margin = space * 0.04;
  const unit = space / 1000;
  const nodeRadius = unit * 9;
  const valleys = new Set(options.valleyNodes ?? []);

  const headroom = unit * 70;
  const footroom = unit * 110;
  const parts: string[] = [];
  const canvasHeight = space + margin * 2 + headroom + footroom;
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin - headroom} ${
      space + margin * 2
    } ${canvasHeight}" width="1400">`,
  );
  parts.push(
    `<rect x="${-margin}" y="${-margin - headroom}" width="${space + margin * 2}" height="${canvasHeight}" fill="#f4f1e8"/>`,
  );

  parts.push(header(map, unit));

  // Edges first, so nodes sit on top of them.
  parts.push('<g stroke="#a89b84" stroke-linecap="round">');
  for (const edge of map.graph.edges) {
    const from = map.graph.nodes[edge.a];
    const to = map.graph.nodes[edge.b];
    if (from === undefined || to === undefined) continue;
    parts.push(
      `<line x1="${round(from.position.x)}" y1="${round(from.position.y)}" x2="${round(to.position.x)}" y2="${round(
        to.position.y,
      )}" stroke-width="${round(unit * 2.5)}"/>`,
    );
  }
  parts.push('</g>');

  // Remoteness halos, under the nodes: the darker the ring, the more remote the
  // POI. This is the layer the player-facing renderer must never have.
  parts.push('<g>');
  for (const poi of map.pois) {
    const node = map.graph.nodes[poi.node];
    if (node === undefined) continue;
    const shade = Math.round(255 - poi.remoteness * 200);
    parts.push(
      `<circle cx="${round(node.position.x)}" cy="${round(node.position.y)}" r="${round(nodeRadius * 2)}" fill="rgb(${shade},${shade},${shade})" fill-opacity="0.55"/>`,
    );
  }
  parts.push('</g>');

  for (const node of map.graph.nodes) {
    const poi = poiAt(map, node.id);
    const leaf = isLeaf(map.graph, node.id);
    const stroke = poi !== undefined ? '#1c1c1c' : valleys.has(node.id) ? '#2e6fb7' : '#6b6152';
    const width = poi !== undefined ? unit * 3.5 : valleys.has(node.id) ? unit * 3 : unit * 1.2;
    const radius = poi !== undefined ? nodeRadius * 1.25 : nodeRadius;
    parts.push(
      `<circle cx="${round(node.position.x)}" cy="${round(node.position.y)}" r="${round(radius)}" fill="${
        TERRAIN_FILL[node.terrain]
      }" stroke="${stroke}" stroke-width="${round(width)}"${valleys.has(node.id) ? ' stroke-dasharray="' + round(unit * 4) + '"' : ''}/>`,
    );
    if (leaf) {
      // Outside the node, up and to the left, so it never sits on the POI's
      // reward label.
      const size = nodeRadius * 0.7;
      parts.push(
        `<rect x="${round(node.position.x - radius - size)}" y="${round(
          node.position.y - radius - size,
        )}" width="${round(size)}" height="${round(size)}" fill="#1c1c1c"/>`,
      );
    }
    if (poi !== undefined) parts.push(poiLabel(poi, node.position.x, node.position.y, unit, nodeRadius));
  }

  parts.push(legend(map, unit, space));
  parts.push('</svg>');
  return parts.join('\n');
}

function poiLabel(poi: Poi, x: number, y: number, unit: number, nodeRadius: number): string {
  const kind = `${KIND_LABEL[poi.reward.kind] ?? poi.reward.kind}${poi.reward.units}`;
  const parts = [
    `<text x="${round(x)}" y="${round(y + unit * 5)}" font-family="monospace" font-size="${round(
      unit * 14,
    )}" text-anchor="middle" fill="#101010">${escapeXml(kind)}</text>`,
  ];
  if (poi.guard !== null) {
    parts.push(
      `<text x="${round(x + nodeRadius * 1.6)}" y="${round(y - nodeRadius * 0.8)}" font-family="monospace" font-size="${round(
        unit * 16,
      )}" font-weight="bold" text-anchor="middle" fill="${GUARD_COLOR[poi.guard.type] ?? '#000'}">${
        poi.guard.strength
      }</text>`,
    );
  }
  return parts.join('\n');
}

function header(map: GameMap, unit: number): string {
  const total = map.graph.nodes.length;
  const shares = TERRAINS.map(
    (terrain) =>
      `${terrain} ${Math.round((map.graph.nodes.filter((node) => node.terrain === terrain).length / total) * 100)}%`,
  ).join('  ');
  const line = `seed "${map.seed}"  ${total} nodes  ${map.graph.edges.length} edges  ${map.pois.length} POIs  attempts ${map.attempts}  ${shares}`;
  return `<text x="0" y="${round(-unit * 24)}" font-family="monospace" font-size="${round(
    unit * 22,
  )}" fill="#101010">${escapeXml(line)}</text>`;
}

function legend(map: GameMap, unit: number, space: number): string {
  const text = [
    'black ring = POI, label = reward kind + units, coloured number = guard strength (red fighting, purple magic)',
    'grey halo = remoteness, darker is more remote (generator internal — the player-facing map never shows it)',
    'black square = leaf node, blue dashed ring = node carved into a plains valley (step 6)',
  ];
  return text
    .map(
      (line, index) =>
        `<text x="0" y="${round(space + unit * (22 + index * 26))}" font-family="monospace" font-size="${round(
          unit * 18,
        )}" fill="#3a3a3a">${escapeXml(line)}</text>`,
    )
    .join('\n');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
