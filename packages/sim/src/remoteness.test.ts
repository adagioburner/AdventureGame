import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, type GameConfig } from '@adventure/config';
import { asNodeId, createRng, type MapGraph, type NodeId } from '@adventure/core';
import { computeRemoteness, segmentSumRemotenessScorer, withDistanceFrom, type RemotenessScorer } from './remoteness.ts';

const n = (value: number): NodeId => asNodeId(value);

/** Seven plains spaces in a row; sites at both ends and in the middle. */
const line: MapGraph = {
  nodes: Array.from({ length: 7 }, (_unused, index) => ({ id: n(index), position: { x: index, y: 0 }, terrain: 'plains' as const })),
  edges: Array.from({ length: 6 }, (_unused, index) => ({ a: n(index), b: n(index + 1) })),
  adjacency: Array.from({ length: 7 }, (_unused, index) => [index - 1, index + 1].filter((next) => next >= 0 && next < 7).map(n)),
};
const sites = [n(0), n(3), n(6)];

/** Walks that always go to the nearest site, so the first site shows where a walk started. */
const config: GameConfig = {
  ...DEFAULT_RULESET.config,
  balancing: { ...DEFAULT_RULESET.config.balancing, REMOTENESS_CANDIDATE_COUNT: 1, REMOTENESS_SIMULATION_RUNS: 40 },
};

/** The default scorer, also noting the first site of every walk. */
function firstSites(): { readonly scorer: RemotenessScorer; readonly first: NodeId[] } {
  const inner = segmentSumRemotenessScorer();
  const first: NodeId[] = [];
  return {
    first,
    scorer: {
      beginWalk: () => inner.beginWalk(),
      record: (visit) => {
        if (visit.order === 0) first.push(visit.target);
        inner.record(visit);
      },
      endWalk: () => inner.endWalk(),
      finish: () => inner.finish(),
    },
  };
}

describe('§5.1 remoteness walks', () => {
  it('start from any plains space when given none (as before Q226)', () => {
    const { scorer, first } = firstSites();
    computeRemoteness(line, sites, config, createRng('walks'), scorer);
    expect(new Set(first)).toEqual(new Set(sites));
  });

  it('start only from the spaces given, one drawn for each walk (Q226, 858)', () => {
    const near = firstSites();
    computeRemoteness(line, sites, config, createRng('walks'), near.scorer, [n(1)]);
    expect(new Set(near.first)).toEqual(new Set([n(0)]));

    const both = firstSites();
    computeRemoteness(line, sites, config, createRng('walks'), both.scorer, [n(1), n(5)]);
    expect(new Set(both.first)).toEqual(new Set([n(0), n(6)]));
  });
});

describe('§5.1 remoteness, half from the start (Q226, 863)', () => {
  // Walk scores for the three sites, and their stamina from space 1: 1, 2 and 5.
  const walked = new Map([
    [n(0), 1],
    [n(3), 0],
    [n(6), 0.5],
  ]);

  it('is the walk score alone at share 0, and the distance from the start alone at share 1', () => {
    expect(withDistanceFrom(walked, line, n(1), 0, config)).toEqual(walked);
    expect(withDistanceFrom(walked, line, n(1), 1, config)).toEqual(
      new Map([
        [n(0), 0],
        [n(3), 0.25],
        [n(6), 1],
      ]),
    );
  });

  it('mixes the two by the share, then scales the mix to [0, 1] again', () => {
    // Half and half: 0.5, 0.125 and 0.75, scaled from 0.125..0.75.
    const mixed = withDistanceFrom(walked, line, n(1), 0.5, config);
    expect(mixed.get(n(3))).toBe(0);
    expect(mixed.get(n(0))).toBeCloseTo(0.6, 10);
    expect(mixed.get(n(6))).toBe(1);
  });
});
