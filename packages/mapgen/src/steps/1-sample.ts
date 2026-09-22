import type { NodeId, Point } from '@adventure/core';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 1 — "Sample positions: Poisson-disc sampling over the map
 * rectangle, ~240 points."
 *
 * `MAP_NODE_COUNT` is a target, not an exact count; the disc radius is derived
 * from it and `MAP_COORDINATE_SPACE` via `POISSON_RADIUS_FACTOR`, which is an
 * engineering knob, not a design value.
 */
export const sampleStep: GenerationStep = {
  id: '1-sample',
  gdd: 'GDD.md §2.1 step 1',
  run(draft: MapDraft, context: GenerationContext): void {
    draft.positions = poissonDiscSample(context);
    draft.edges = [];
    draft.terrain = [];
    draft.adjacency = draft.positions.map((): NodeId[] => []);
    draft.poiNodes = [];
    draft.remoteness = new Map();
    draft.valleyNodes = new Set();
    draft.assignments = [];
  },
};

/**
 * Bridson's algorithm: candidates are thrown into the annulus around an active
 * sample and kept when they clear every existing sample by `radius`. `k` below
 * is Bridson's own rejection budget, an artefact of that algorithm rather than
 * a number from GDD.md §11 — 30 is the value the paper uses.
 */
const CANDIDATES_PER_ACTIVE_SAMPLE = 30;

/**
 * The Poisson-disc minimum separation, as `POISSON_RADIUS_FACTOR` documents it:
 * a fraction of the naive spacing that `MAP_NODE_COUNT` points would have on a
 * square grid over `MAP_COORDINATE_SPACE`, i.e. `√(A / N)`.
 *
 * Poisson-disc sampling packs looser than that grid, so the factor is below 1
 * to bring the yield back up to the target. The yield is a distribution rather
 * than a number — expect the node count to vary by a few percent from seed to
 * seed, which §2's "~240 nodes" allows for.
 */
function minimumSeparation(context: GenerationContext): number {
  const { MAP_COORDINATE_SPACE, MAP_NODE_COUNT } = context.ruleset.config.map;
  const area = MAP_COORDINATE_SPACE * MAP_COORDINATE_SPACE;
  return Math.sqrt(area / MAP_NODE_COUNT) * context.ruleset.engineering.POISSON_RADIUS_FACTOR;
}

function poissonDiscSample(context: GenerationContext): Point[] {
  const space = context.ruleset.config.map.MAP_COORDINATE_SPACE;
  const rng = context.rng;
  const radius = minimumSeparation(context);
  const radiusSquared = radius * radius;

  // A background grid whose cells are small enough to hold at most one sample,
  // so a candidate only has to be checked against its 5×5 cell neighbourhood.
  const cellSize = radius / Math.SQRT2;
  const gridWidth = Math.ceil(space / cellSize);
  const grid = new Array<number>(gridWidth * gridWidth).fill(-1);

  const samples: Point[] = [];
  const active: number[] = [];

  const cellIndexOf = (point: Point): number => {
    const column = Math.min(gridWidth - 1, Math.floor(point.x / cellSize));
    const row = Math.min(gridWidth - 1, Math.floor(point.y / cellSize));
    return row * gridWidth + column;
  };

  const farEnough = (point: Point): boolean => {
    const column = Math.floor(point.x / cellSize);
    const row = Math.floor(point.y / cellSize);
    for (let r = Math.max(0, row - 2); r <= Math.min(gridWidth - 1, row + 2); r++) {
      for (let c = Math.max(0, column - 2); c <= Math.min(gridWidth - 1, column + 2); c++) {
        const index = grid[r * gridWidth + c] ?? -1;
        if (index < 0) continue;
        const other = samples[index] as Point;
        const dx = other.x - point.x;
        const dy = other.y - point.y;
        if (dx * dx + dy * dy < radiusSquared) return false;
      }
    }
    return true;
  };

  const accept = (point: Point): void => {
    grid[cellIndexOf(point)] = samples.length;
    active.push(samples.length);
    samples.push(point);
  };

  accept({ x: rng.nextFloat() * space, y: rng.nextFloat() * space });

  while (active.length > 0) {
    // Draw the active sample by index so the stream advances identically
    // whether or not the draw succeeds.
    const slot = rng.nextInt(active.length);
    const origin = samples[active[slot] as number] as Point;

    let placed = false;
    for (let attempt = 0; attempt < CANDIDATES_PER_ACTIVE_SAMPLE; attempt++) {
      const angle = rng.nextFloat() * Math.PI * 2;
      const distance = radius * (1 + rng.nextFloat());
      const candidate: Point = {
        x: origin.x + Math.cos(angle) * distance,
        y: origin.y + Math.sin(angle) * distance,
      };
      if (candidate.x < 0 || candidate.x >= space || candidate.y < 0 || candidate.y >= space) continue;
      if (!farEnough(candidate)) continue;
      accept(candidate);
      placed = true;
      break;
    }

    if (!placed) {
      active[slot] = active[active.length - 1] as number;
      active.pop();
    }
  }

  return samples;
}
