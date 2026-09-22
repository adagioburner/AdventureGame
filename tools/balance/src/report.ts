import { TERRAINS, type Ruleset, type Terrain } from '@adventure/config';
import type { GameMap } from '@adventure/core';
import type { MapGenerationReport } from './index.ts';

/**
 * The stdout half of `pnpm map` and `pnpm map:batch` — the same numbers §11
 * names as tunable, laid out so a reviewer can see at a glance whether a map
 * came out "according to set parameters".
 *
 * Text, one record per line, deliberately: it is the same shape as the golden
 * files under `golden/`, so a report pasted into a review and a snapshot diff
 * read the same way.
 */
export function formatMapReport(report: MapGenerationReport, ruleset: Ruleset): string {
  const { map: mapConfig, pois } = ruleset.config;
  const lines: string[] = [];

  lines.push(`seed                  ${report.seed}`);
  lines.push(`attempts              ${report.attempts} (max ${ruleset.engineering.MAX_GENERATION_ATTEMPTS})`);
  lines.push(`nodes                 ${report.nodeCount} (target ~${mapConfig.MAP_NODE_COUNT})`);
  lines.push(`edges                 ${report.edgeCount} (target ~${mapConfig.MAP_EDGE_COUNT})`);
  lines.push(`leaves                ${report.leafCount} (want ${mapConfig.LEAF_COUNT.min}-${mapConfig.LEAF_COUNT.max})`);
  lines.push(
    `POIs                  ${report.poiCount} (§4.2 quota ${TERRAINS.reduce((sum, t) => sum + pois.POI_COUNT[t], 0)} + surplus leaves)`,
  );
  lines.push(`valley nodes          ${report.valleyNodes.length}`);
  lines.push('');
  lines.push(`terrain share (§2.1 step 4 target ${TERRAINS.map((t) => percent(mapConfig.TERRAIN_AREA_SHARE[t])).join(' / ')})`);
  lines.push(`  finished map        ${TERRAINS.map((t) => percent(report.terrainShares[t])).join(' / ')}`);
  lines.push(`  before the valleys  ${TERRAINS.map((t) => percent(report.terrainSharesAfterSmooth[t])).join(' / ')}`);
  lines.push('');
  lines.push(`compactness, worst component per terrain (COMPACTNESS_MAX ${mapConfig.COMPACTNESS_MAX})`);
  lines.push(`  after smooth        ${TERRAINS.map((t) => fixed(report.compactnessAfterSmooth[t])).join(' / ')}`);
  lines.push(`  after valleys       ${TERRAINS.map((t) => fixed(report.compactnessAfterValleys[t])).join(' / ')}  (expected to be worse)`);
  lines.push('');
  lines.push(`remoteness [0,1] per POI   ${bars(report.remotenessHistogram)}`);
  lines.push(`guard strength 0-${pois.GUARD_STRENGTH.max}         ${bars(report.guardStrengthHistogram)}`);
  lines.push(`gold units            ${report.goldUnitsTotal}`);

  return lines.join('\n');
}

/** The §11 distributions over a whole batch — what `pnpm map:batch` is for. */
export function formatBatchReport(reports: readonly MapGenerationReport[], ruleset: Ruleset): string {
  const { map: mapConfig, pois } = ruleset.config;
  const lines: string[] = [];
  const count = reports.length;

  lines.push(`${count} seeds`);
  lines.push('');
  lines.push(`                      min    mean     max    target`);
  lines.push(spread('attempts', reports.map((r) => r.attempts), `<= ${ruleset.engineering.MAX_GENERATION_ATTEMPTS}`));
  lines.push(spread('nodes', reports.map((r) => r.nodeCount), `~${mapConfig.MAP_NODE_COUNT}`));
  lines.push(spread('edges', reports.map((r) => r.edgeCount), `~${mapConfig.MAP_EDGE_COUNT}`));
  lines.push(
    spread('leaves', reports.map((r) => r.leafCount), `${mapConfig.LEAF_COUNT.min}-${mapConfig.LEAF_COUNT.max}`),
  );
  lines.push(spread('POIs', reports.map((r) => r.poiCount), '60 + surplus'));
  lines.push(spread('valley nodes', reports.map((r) => r.valleyNodes.length), '2-4 x 5-12'));
  lines.push('');

  // The finished map, not the draft before step 6 — the share targets are a
  // statement about the map a player is handed. See §2.1 step 6.
  for (const terrain of TERRAINS) {
    lines.push(
      spread(
        `${terrain} share %`,
        reports.map((r) => (r.terrainShares[terrain] as number) * 100),
        percent(mapConfig.TERRAIN_AREA_SHARE[terrain]),
      ),
    );
  }
  lines.push('');
  for (const terrain of TERRAINS) {
    lines.push(
      spread(
        `${terrain} compact.`,
        reports.map((r) => r.compactnessAfterSmooth[terrain] as number),
        `< ${mapConfig.COMPACTNESS_MAX}`,
      ),
    );
  }
  lines.push('');
  lines.push(`remoteness [0,1] over ${count} maps  ${bars(sum(reports.map((r) => r.remotenessHistogram)))}`);
  lines.push(`guard strength 0-${pois.GUARD_STRENGTH.max}             ${bars(sum(reports.map((r) => r.guardStrengthHistogram)))}`);

  return lines.join('\n');
}

function spread(label: string, values: readonly number[], target: string): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return `${label.padEnd(20)}${fixed(min).padStart(6)}${fixed(mean).padStart(8)}${fixed(max).padStart(8)}    ${target}`;
}

function sum(histograms: readonly (readonly number[])[]): number[] {
  const total: number[] = [];
  for (const histogram of histograms) {
    histogram.forEach((value, index) => {
      total[index] = (total[index] ?? 0) + value;
    });
  }
  return total;
}

function bars(histogram: readonly number[]): string {
  return histogram.map((value) => String(value).padStart(4)).join('');
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function fixed(value: number | undefined): string {
  if (value === undefined) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The one-line-per-record summary that goes in `golden/maps/`.
 *
 * Deliberately *not* the SVG: a committed SVG would snapshot the same map a
 * second time and churn on every cosmetic change to the renderer, while this
 * changes only when generation itself does. See `golden/README.md`.
 */
export function formatMapSummary(map: GameMap): string {
  const lines: string[] = [];
  lines.push(`# ${map.seed} — generated map summary. See golden/README.md before updating.`);
  lines.push(`meta attempts=${map.attempts} nodes=${map.graph.nodes.length} edges=${map.graph.edges.length} pois=${map.pois.length}`);
  for (const terrain of TERRAINS) {
    const nodes = map.graph.nodes.filter((node) => node.terrain === terrain).length;
    lines.push(`terrain ${terrain} nodes=${nodes}`);
  }
  for (const node of map.graph.nodes) {
    lines.push(`node ${node.id} ${node.terrain} x=${Math.round(node.position.x)} y=${Math.round(node.position.y)}`);
  }
  for (const edge of map.graph.edges) lines.push(`edge ${edge.a} ${edge.b}`);
  for (const poi of map.pois) {
    lines.push(
      `poi ${poi.node} ${poi.terrain} ${poi.reward.kind} units=${poi.reward.units} ` +
        `group=${poi.group.kind}/${poi.group.guard ?? 'unguarded'} ` +
        `guard=${poi.guard === null ? 'none' : `${poi.guard.type}:${poi.guard.strength}`} ` +
        `remoteness=${poi.remoteness.toFixed(6)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
