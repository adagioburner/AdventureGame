import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { isLeaf } from '@adventure/core';
import { generateAndReport } from './index.ts';
import { formatBatchReport, formatMapReport, formatMapSummary } from './report.ts';
import { renderMapSvg } from './svg.ts';

const { map, report } = generateAndReport('adventure', DEFAULT_RULESET);
const svg = renderMapSvg(map, { valleyNodes: report.valleyNodes });

function count(haystack: string, needle: RegExp): number {
  return haystack.match(needle)?.length ?? 0;
}

/**
 * Step 1 asks for a map "viewable by humans", so these check that every visual
 * element the drawing is supposed to carry is actually in it — one per thing
 * generation produced, not merely "an SVG came out".
 */
describe('renderMapSvg', () => {
  it('is a well-formed SVG document with a viewBox', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox=');
  });

  it('draws one line per edge', () => {
    expect(count(svg, /<line /g)).toBe(map.graph.edges.length);
  });

  it('draws one node per node, plus one remoteness halo per POI', () => {
    expect(count(svg, /<circle /g)).toBe(map.graph.nodes.length + map.pois.length);
  });

  it('colours every node by its terrain, and uses all three colours', () => {
    for (const fill of ['#d8c08a', '#5d8f57', '#9a9aa4']) expect(svg).toContain(fill);
  });

  it('draws nothing but the background as a rect', () => {
    // Leaves used to carry a black square each. Andrei asked for them dropped
    // on 2026-09-22 — "the leaves are pretty self-evident and easy to see" —
    // and a node with one road out is indeed obvious on the drawing. The
    // §11 leaf *count* is still reported and still tested; it is only the
    // marker that went.
    expect(count(svg, /<rect /g)).toBe(1);
  });

  it('marks every node carved into a plains valley', () => {
    expect(report.valleyNodes.length).toBeGreaterThan(0);
    expect(count(svg, /stroke-dasharray=/g)).toBe(report.valleyNodes.length);
  });

  it('labels every POI with its reward kind and unit count', () => {
    const goldTwo = map.pois.filter((poi) => poi.reward.kind === 'gold' && poi.reward.units === 2).length;
    expect(goldTwo).toBeGreaterThan(0);
    expect(count(svg, />G2</g)).toBe(goldTwo);
  });

  it('prints a guard strength, in its guard type’s colour, beside every guarded POI', () => {
    const fighting = map.pois.filter((poi) => poi.guard?.type === 'fighting').length;
    const magic = map.pois.filter((poi) => poi.guard?.type === 'magic').length;
    expect(fighting + magic).toBeGreaterThan(0);
    expect(count(svg, /fill="#c0392b"/g)).toBe(fighting);
    expect(count(svg, /fill="#8e44ad"/g)).toBe(magic);
  });

  it('shades each POI by remoteness, which is the layer the player-facing map must not have', () => {
    const shades = svg.match(/fill="rgb\((\d+),\1,\1\)"/g) ?? [];
    expect(shades.length).toBe(map.pois.length);
    // Remoteness spans [0, 1], so the lightest and darkest shades differ.
    expect(new Set(shades).size).toBeGreaterThan(1);
  });

  it('names the seed and the headline counts, and carries the legend', () => {
    expect(svg).toContain('seed &quot;adventure&quot;');
    expect(svg).toContain(`${map.graph.nodes.length} nodes`);
    expect(svg).toContain(`${map.pois.length} POIs`);
    expect(svg).toContain('black ring = POI');
    expect(svg).toContain('grey halo = remoteness');
    expect(svg).toContain('blue dashed ring = node carved into a plains valley');
    expect(svg).not.toContain('leaf node');
  });

  it('escapes a seed that would otherwise break the document', () => {
    const hostile = renderMapSvg({ ...map, seed: '<script>&"' });
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('&lt;script&gt;&amp;&quot;');
  });

  it('draws no valley marks when it is not told which nodes were carved', () => {
    expect(count(renderMapSvg(map), /stroke-dasharray=/g)).toBe(0);
  });
});

describe('the stdout reports', () => {
  it('names every §11 quantity the map harness exists to tune', () => {
    const text = formatMapReport(report, DEFAULT_RULESET);
    for (const line of ['seed', 'nodes', 'edges', 'leaves', 'terrain share', 'compactness', 'remoteness', 'guard strength']) {
      expect(text).toContain(line);
    }
    expect(text).toContain('adventure');
  });

  it('reports a batch as min / mean / max against each target', () => {
    const text = formatBatchReport([report, report], DEFAULT_RULESET);
    expect(text).toContain('2 seeds');
    expect(text).toContain('min    mean     max    target');
    expect(text).toContain('plains share %');
  });
});

describe('formatMapSummary', () => {
  it('records one line per node, edge and POI, so a golden diff is legible', () => {
    const summary = formatMapSummary(map);
    expect(count(summary, /^node /gm)).toBe(map.graph.nodes.length);
    expect(count(summary, /^edge /gm)).toBe(map.graph.edges.length);
    expect(count(summary, /^poi /gm)).toBe(map.pois.length);
  });

  it('writes remoteness at full precision, so a drift in §5.1 shows up', () => {
    expect(formatMapSummary(map)).toMatch(/remoteness=\d\.\d{6}/);
  });
});

describe('generateAndReport', () => {
  it('measures compactness both after Smooth and after Carve Valleys', () => {
    expect(Object.keys(report.compactnessAfterSmooth)).toEqual(['plains', 'forest', 'mountain']);
    expect(Object.keys(report.compactnessAfterValleys)).toEqual(['plains', 'forest', 'mountain']);
  });

  it('counts the surplus-leaf POIs into the POI total', () => {
    expect(report.poiCount).toBe(map.pois.length);
    expect(report.leafCount).toBe(map.graph.nodes.filter((node) => isLeaf(map.graph, node.id)).length);
  });

  it('histograms every guarded row, the ones §5.2 capped to 0 included', () => {
    const guardedRows = map.pois.filter((poi) => poi.group.guard !== null).length;
    expect(report.guardStrengthHistogram.reduce((sum, value) => sum + value, 0)).toBe(guardedRows);
  });
});
