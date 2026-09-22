import type { Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from '@adventure/core';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 6 — "Carve valleys: convert 2–4 narrow (1-node-wide) fingers of
 * 5–12 nodes from the plains boundary into neighbouring regions; these nodes
 * are exempted from the Smooth step (there is only the one Smooth pass, above —
 * Carve Valleys runs once, after it)."
 *
 * Counts and lengths come from `VALLEY_COUNT`, `VALLEY_WIDTH`, `VALLEY_LENGTH`.
 * Carved nodes are recorded in `draft.valleyNodes`; see the note on that field
 * for why the exemption is currently satisfied by ordering alone.
 *
 * **What keeps a finger one node wide.** `VALLEY_WIDTH` is 1, and the finger
 * grows one node at a time into non-plains ground, refusing any node that
 * already touches plains other than the node it is stepping from. So a finger
 * cannot run alongside the region it came out of, cannot touch itself, and
 * cannot merge with another finger — each of those would make it two nodes wide
 * somewhere. A finger with nowhere left to go simply ends early, which is why a
 * map can carry a valley shorter than `VALLEY_LENGTH.min`; §2.1 asks for narrow
 * fingers, and a stunted one is narrow.
 */
export const carveValleysStep: GenerationStep = {
  id: '6-carve-valleys',
  gdd: 'GDD.md §2.1 step 6',
  run(draft: MapDraft, context: GenerationContext): void {
    const { VALLEY_COUNT, VALLEY_LENGTH, VALLEY_WIDTH } = context.ruleset.config.map;
    const { rng } = context;

    const valleys = rng.nextIntInclusive(VALLEY_COUNT.min, VALLEY_COUNT.max);
    for (let valley = 0; valley < valleys; valley++) {
      const length = rng.nextIntInclusive(VALLEY_LENGTH.min, VALLEY_LENGTH.max);
      // Only a mouth with a legal first step counts. A plains node can sit on
      // the boundary and still have no one-node-wide way in — every neighbour
      // across the border already touches plains somewhere else — and starting
      // there would spend a valley on nothing.
      const mouths = plainsBoundaryNodes(draft).filter(
        (node) => nextValleyNodes(draft, node, VALLEY_WIDTH).length > 0,
      );
      if (mouths.length === 0) return;
      carveOne(draft, rng.pick(mouths), length, VALLEY_WIDTH, rng);
    }
  },
};

/** Plains nodes with at least one neighbour of another terrain — where a finger starts. */
function plainsBoundaryNodes(draft: MapDraft): NodeId[] {
  const mouths: NodeId[] = [];
  for (let index = 0; index < draft.terrain.length; index++) {
    if (draft.terrain[index] !== 'plains') continue;
    const touchesOther = (draft.adjacency[index] ?? []).some(
      (neighbour) => draft.terrain[neighbour] !== undefined && draft.terrain[neighbour] !== 'plains',
    );
    if (touchesOther) mouths.push(asNodeId(index));
  }
  return mouths;
}

/**
 * Where a finger standing on `head` may step next: a non-plains neighbour that
 * touches no plains other than `head` itself. Anything else would make the
 * finger `width` + 1 nodes across at that point — it would run alongside the
 * region it came from, double back on itself, or merge with another finger.
 */
function nextValleyNodes(draft: MapDraft, head: NodeId, width: number): NodeId[] {
  return (draft.adjacency[head] ?? []).filter((candidate) => {
    const terrain: Terrain | undefined = draft.terrain[candidate];
    if (terrain === undefined || terrain === 'plains') return false;
    const plainsTouched = (draft.adjacency[candidate] ?? []).filter(
      (neighbour) => neighbour !== head && draft.terrain[neighbour] === 'plains',
    );
    return plainsTouched.length < width;
  });
}

function carveOne(
  draft: MapDraft,
  mouth: NodeId,
  length: number,
  width: number,
  rng: GenerationContext['rng'],
): void {
  let head = mouth;

  for (let step = 0; step < length; step++) {
    const options = nextValleyNodes(draft, head, width);
    if (options.length === 0) break;

    const next = rng.pick(options);
    draft.terrain[next] = 'plains';
    draft.valleyNodes.add(next);
    head = next;
  }
}
