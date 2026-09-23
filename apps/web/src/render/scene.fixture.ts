import { DEFAULT_RULESET, type Ruleset } from '@adventure/config';
import {
  asGameId,
  asPlayerId,
  chooseStartingNode,
  createGameState,
  createRng,
  previewPath,
  shortestPath,
  type GameMap,
  type GameState,
  type MovementAllowance,
  type NodeId,
  type PathPreview,
  type Seed,
} from '@adventure/core';
import { generateMap } from '@adventure/mapgen';
import { defaultRemotenessScorer } from '@adventure/sim';

/**
 * A map generated from a seed, the two hotseat players (Q22) standing on their
 * shared starting node, and one sample move: what the scene tests draw.
 *
 * Not part of the app — the page plans real moves since phase 4 — and named
 * `*.fixture.ts` so Vitest does not collect it while the typecheck still does.
 */
export interface PreviewGame {
  readonly map: GameMap;
  readonly state: GameState;
  readonly sample: SampleMove | null;
}

/**
 * A prospective move with all three of §7.1's path colours. A fresh game's
 * players hold no moving skills, so their every step would be yellow; the
 * sample is instead what `previewPath` returns for the player in §8's worked
 * example — 14 stamina, plains-move 3, forest-move 1 — walking from the
 * starting node to the nearest POI whose route shows all three colours.
 */
export interface SampleMove {
  readonly preview: PathPreview;
  readonly waypoint: NodeId | null;
  readonly allowance: MovementAllowance;
  readonly stamina: number;
}

export const SAMPLE_ALLOWANCE: MovementAllowance = { plains: 3, forest: 1, mountain: 0 };
export const SAMPLE_STAMINA = 14;

export function previewGame(seed: Seed, ruleset: Ruleset = DEFAULT_RULESET): PreviewGame {
  const map = generateMap({ seed, ruleset, remotenessScorer: defaultRemotenessScorer });
  const startingNode = chooseStartingNode(map, createRng(map.seed).fork('starting-node'));
  const state = createGameState({
    id: asGameId(`preview-${seed}`),
    map,
    players: [
      { id: asPlayerId('p1'), name: 'Player 1', avatarId: 'player_avatars_01', control: 'human' },
      { id: asPlayerId('p2'), name: 'Player 2', avatarId: 'player_avatars_02', control: 'human' },
    ],
    startingNode,
  });
  return { map, state, sample: sampleMove(map, startingNode, ruleset) };
}

export function sampleMove(map: GameMap, from: NodeId, ruleset: Ruleset = DEFAULT_RULESET): SampleMove | null {
  const config = ruleset.config;
  let best: { preview: PathPreview; path: readonly NodeId[] } | null = null;
  for (const poi of map.pois) {
    const path = shortestPath(map.graph, from, poi.node, config);
    if (path === null || path.length === 0) continue;
    if (best !== null && path.length >= best.path.length) continue;
    const preview = previewPath(map.graph, from, path, SAMPLE_ALLOWANCE, SAMPLE_STAMINA, config);
    const colors = new Set(preview.steps.map((step) => step.color));
    if (colors.size === 3) best = { preview, path };
  }
  if (best === null) return null;
  const middle = best.path[Math.floor(best.path.length / 2) - 1] ?? null;
  return { preview: best.preview, waypoint: middle, allowance: SAMPLE_ALLOWANCE, stamina: SAMPLE_STAMINA };
}
