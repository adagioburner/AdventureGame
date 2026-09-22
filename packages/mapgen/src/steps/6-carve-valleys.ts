import type { Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from '@adventure/core';
import { rebalanceTerrainShares, terrainTargets } from '../terraingrowth.ts';
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
 *
 * **A valley moves plains; it does not create it.** [SOURCE §2.1, chat] The
 * shares §2.1 step 4 states are a property of the map a player is handed, not
 * of an intermediate draft, so carving ends by growing the terrains that are
 * now short back into plains until the shares hold again. Without it a valley
 * is a permanent donation to plains, and because §4.2 fixes the POI count per
 * terrain — 25 plains, 20 forest, 15 mountain, whatever the node counts —
 * every node the valleys take out of mountain also crowds mountain's POIs
 * closer together. Measured before this was added, `adventure` finished 65 / 26
 * / 9 against 45 / 30 / 25, with two thirds of every mountain node carrying a
 * POI and one plains POI per 6.2 nodes.
 *
 * The regrowth is the same flood fill as step 4 (`bestGrowthCandidate`), with
 * two differences that matter. It takes nodes from a terrain that is *over* its
 * target rather than from unclaimed ground, so unlike step 4 it cannot be
 * sealed off — plains is everywhere by now. And it never takes a valley node or
 * the plains node a valley opens out of, so a corridor keeps both its shape and
 * its mouth. Between them, that is also what fixes step 4's own overshoot,
 * which is why the shares land closer now than the growth alone ever managed.
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
      if (mouths.length === 0) break;
      carveOne(draft, rng.pick(mouths), length, VALLEY_WIDTH, rng);
    }

    rebalanceTerrainShares(
      draft.terrain,
      draft.adjacency,
      terrainTargets(draft.terrain.length, context.ruleset.config.map.TERRAIN_AREA_SHARE),
      lockedNodes(draft),
      context.rng,
    );
  },
};

/**
 * What the regrowth may not take: the carved nodes themselves, and the plains
 * node each valley opens out of. Walling off a mouth would leave a corridor
 * that starts nowhere, which is a streak of plains inside a mountain range
 * rather than a valley. A valley node's only plains neighbours are its mouth
 * and the rest of its own finger, so asking for plains beside a carved node
 * names exactly those.
 */
function lockedNodes(draft: MapDraft): ReadonlySet<NodeId> {
  const locked = new Set<NodeId>(draft.valleyNodes);
  for (const node of draft.valleyNodes) {
    for (const neighbour of draft.adjacency[node] ?? []) {
      if (draft.terrain[neighbour] === 'plains') locked.add(neighbour);
    }
  }
  return locked;
}

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
