import { TERRAINS, type GameConfig, type PerTerrain, type RewardKind, type Terrain } from '@adventure/config';
import {
  applyAction,
  buyableNow,
  playerById,
  poiAt,
  previewPath,
  routeTable,
  type DiceSource,
  type GameState,
  type NodeId,
  type PlayerId,
  type PlayerState,
  type Rng,
} from '@adventure/core';
import {
  cheapestRoute,
  closestPoiCandidates,
  unclaimedPoiNodes,
  winnablePoiNodesWith,
  winsOnSomeRoll,
  type ClosestFinder,
  type PoiCandidate,
  type RouteChoice,
  type RouteStepsFinder,
  type TargetFilter,
} from '@adventure/sim';
import type { ActionEnumerator, MctsBranch, MctsNode, TreePolicy, TurnReachability } from '../types.ts';

/**
 * [SOURCE §12.2, chat] "For everything else please use sensible defaults that
 * are recommended for standard MCTS implementations."
 *
 * That default is UCT — UCB1 applied to the tree:
 *
 *   value(child) = child.totalValue / child.visits
 *                + c × sqrt( ln(parent.visits) / child.visits )
 *
 * with an unvisited child taken first (its term is infinite). The final move is
 * the **most-visited** child rather than the highest-valued one — the "robust
 * child" rule, which is the standard recommendation because visit counts are
 * far less noisy than value estimates at the end of a fixed time budget.
 *
 * Ties are broken with the injected `Rng`, so a search is reproducible from its
 * seed like everything else in this repo.
 *
 * √2 is the right constant here because every evaluator returns a value in
 * [0, 1] (OPEN_QUESTIONS Q14) — the range UCB1's derivation assumes. Gold terms
 * get there by dividing by total map gold; the estimated evaluator's two terms
 * are each normalised and its weights sum to 1 (Q18). The two settings are
 * coupled.
 */
export function uctTreePolicy(explorationConstant: number): TreePolicy {
  return {
    name: 'uct',

    select(node: MctsNode, available: readonly MctsNode[], rng: Rng): MctsNode {
      if (available.length === 0) {
        throw new RangeError('uctTreePolicy.select called with no child to choose');
      }
      return argMaxWithRandomTieBreak(
        available,
        (child) =>
          child.visits === 0
            ? Number.POSITIVE_INFINITY
            : child.totalValue / child.visits +
              explorationConstant * Math.sqrt(Math.log(node.visits) / child.visits),
        rng,
      );
    },

    bestChild(root: MctsNode): MctsNode {
      // Robust child: most visits, mean value as the tiebreak. Deterministic —
      // no `Rng` is threaded here, and the final move should not be a coin flip.
      let best: MctsNode | null = null;
      for (const child of root.children) {
        if (best === null || beats(child, best)) best = child;
      }
      if (best === null) {
        throw new RangeError('uctTreePolicy.bestChild called on a node with no children');
      }
      return best;
    },
  };
}

function meanValue(node: MctsNode): number {
  return node.visits === 0 ? 0 : node.totalValue / node.visits;
}

function beats(candidate: MctsNode, incumbent: MctsNode): boolean {
  if (candidate.visits !== incumbent.visits) return candidate.visits > incumbent.visits;
  return meanValue(candidate) > meanValue(incumbent);
}

function argMaxWithRandomTieBreak<T>(items: readonly T[], score: (item: T) => number, rng: Rng): T {
  let best: T[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = [item];
    } else if (value === bestScore) {
      best.push(item);
    }
  }
  const first = best[0];
  if (first === undefined) throw new RangeError('argMax over an empty collection');
  return best.length === 1 ? first : rng.pick(best);
}

/**
 * [SOURCE §12.2, chat] "These POIs to explore will be the closest at the time
 * (among those that have not been claimed at that point of time in the game)",
 * plus: "rest is a branch as well. Let us prune it if there are at least
 * MIN_REACHABLE_NODES_FOR_REST = 3 POIs reachable in one turn."
 *
 * [SOURCE §12.2, review] How many is `CLOSE_CANDIDATE_COUNT`, the same K the
 * rollout policy and the remoteness walk use: "We don't really need two
 * different constants here. We will prune the tree by the CLOSE_CANDIDATE_COUNT,
 * plus one branch for resting." The tree's own `MCTS_NODE_EXPANSION_PRUNING` is
 * gone.
 *
 * Both halves are here. Targets are recomputed per node against that node's
 * state, so a POI claimed earlier in the searched line is no longer a branch
 * further down it; and the rest branch is added only when fewer than
 * `MIN_REACHABLE_NODES_FOR_REST` of those targets can actually be reached this
 * turn — which is exactly when a player is stamina-bound and resting is worth
 * considering.
 *
 * Note the reachability test runs over the pruned target list, not every POI on
 * the map: a distant reachable POI outside that list is not a branch, so
 * counting it would let rest be pruned on the strength of a target the search
 * cannot take.
 *
 * [Q190, Q280] Then a buy branch for each speed or skill the player may buy
 * that a move this turn would use up (`buyBranches`). Below a purchase only
 * such moves are branches, and resting is not one (`usesFully`).
 *
 * [Q295] The game's computer skips guarded gold it cannot win (`choicesAt`):
 * "I think the computer player today still considers guarded POIs that it
 * cannot win. [...] This needs to stop." With nothing left it could win, rest
 * is its only branch.
 */
export function closestUnclaimedPoiEnumerator(
  config: GameConfig,
  reachability: TurnReachability,
  /** Which POIs may be targets in place of `unwinnable`'s; every unclaimed one, or those its gold could win, when absent. */
  allowed?: TargetFilter,
  /** Which of those count as closest; by weighted terrain cost when absent. The game passes `closestByBestRoute` (Q210). */
  closest?: ClosestFinder,
  /** The route a move walks, which `usesFully` checks; the cheapest when absent. The game passes `bestRouteForSpeeds` (Q210, 820 A). */
  walkRoute: RouteChoice = cheapestRoute,
  /** [Q295] Whether guarded gold it cannot win is weighed, as before, or skipped (`choicesAt`), as the game passes. */
  unwinnable: 'weighed' | 'skipped' = 'weighed',
): ActionEnumerator {
  const count = config.balancing.CLOSE_CANDIDATE_COUNT;
  const skips = unwinnable === 'skipped';
  const eligibleFor = (state: GameState, player: PlayerState): ReadonlySet<NodeId> => {
    if (allowed !== undefined) return allowed(state, player);
    return skips ? winnablePoiNodesWith(state, player, affordableUnits(state, player)) : unclaimedPoiNodesOf(state);
  };
  const rank = (state: GameState, player: PlayerState, eligible: ReadonlySet<NodeId>, upTo: number): readonly PoiCandidate[] =>
    closest === undefined
      ? closestPoiCandidates(state.map.graph, player.position, eligible, upTo, config, routeTable(state.map.graph, config))
      : closest(state, player, eligible, upTo);
  // The ranking already returns at most `CLOSE_CANDIDATE_COUNT`, so this *is*
  // the pruned list; there is no second cap to apply. Purchases are weighed
  // against it (`buyBranches`).
  const closestTo = (state: GameState, player: PlayerState): readonly PoiCandidate[] => rank(state, player, eligibleFor(state, player), count);
  /**
   * [Q295] The sites the subject may head for. Weighing unwinnable guards,
   * `closestTo`. Skipping them, Andrei's "buy, then go", 2026-10-09: a site
   * is a choice when the units its gold buys could win it, but a guard it
   * reaches this turn only when the skill it holds now, after this turn's
   * purchases, could; the next closest take the places of those it leaves out
   * ("fill up to 10"). Buying stays weighed against `closestTo`, which counts
   * the gold, so a unit is still tried towards a guard it will reach once the
   * units are bought.
   */
  const choicesAt = (state: GameState, player: PlayerState): readonly PoiCandidate[] => {
    if (!skips) return closestTo(state, player);
    const eligible = eligibleFor(state, player);
    const choices: PoiCandidate[] = [];
    for (const candidate of rank(state, player, eligible, eligible.size)) {
      if (choices.length >= count) break;
      const guard = poiAt(state.map, candidate.node)?.guard ?? null;
      if (!winsOnSomeRoll(state, player, guard) && reachability.isReachableThisTurn(state, player.id, candidate)) continue;
      choices.push(candidate);
    }
    return choices;
  };
  // Every pass through a node near the root brings back the same position, so
  // its branches are worked out once; the buy checks trace routes.
  const known = new Map<string, readonly MctsBranch[]>();

  return {
    name: 'closest-unclaimed-pois+rest+buy',
    enumerate(state: GameState, subject: PlayerId, bought: readonly RewardKind[] = []): readonly MctsBranch[] {
      const player = state.players.find((candidate) => candidate.id === subject);
      if (player === undefined) throw new RangeError(`no such player ${subject}`);
      const key = positionKey(state, player, bought);
      const remembered = known.get(key);
      if (remembered !== undefined) return remembered;

      const targets = choicesAt(state, player);
      const branches: MctsBranch[] = [];
      if (bought.length === 0) {
        for (const target of targets) branches.push({ kind: 'target', target });
        const reachable = targets.filter((target) => reachability.isReachableThisTurn(state, subject, target)).length;
        if (reachable < config.ai.MIN_REACHABLE_NODES_FOR_REST) branches.push({ kind: 'rest' });
      } else {
        for (const target of targets) {
          if (usesFully(state, player, target.node, bought, walkRoute)) branches.push({ kind: 'target', target });
        }
      }
      branches.push(...buyBranches(state, player, bought, closestTo, walkRoute));

      if (known.size >= KNOWN_POSITIONS) known.clear();
      known.set(key, branches);
      return branches;
    },
  };
}

/** [Q295] How many units of a skill `player` could buy with its gold now. */
function affordableUnits(state: GameState, player: PlayerState): number {
  return Math.floor(player.stats.gold / state.map.ruleset.config.buying.GOLD_PER_UNIT);
}

/** How many positions an enumerator remembers before it starts again; a few thousand nodes are searched a move. */
const KNOWN_POSITIONS = 20_000;

/** Everything the branches at a position depend on: the subject's place, stats and free steps, what it bought this turn, and which sites are claimed. */
function positionKey(state: GameState, player: PlayerState, bought: readonly RewardKind[]): string {
  const { stats } = player;
  const free = state.turn.allowance;
  let claimed = '';
  state.poiRuntime.forEach((runtime, index) => {
    if (runtime.claimedBy !== null) claimed += `${index},`;
  });
  return (
    `${state.turn.number}|${player.position}|${stats.plains_move},${stats.forest_move},${stats.mountain_move},` +
    `${stats.fighting},${stats.magic},${stats.gold},${stats.stamina}|${free.plains},${free.forest},${free.mountain}|${bought.join()}|${claimed}`
  );
}

/**
 * [Q280] Andrei, 2026-10-05: "After a computer buys (or makes a sequence of
 * purchases; so what was purchased before becomes a property of a MCTS node)
 * it should only make moves that utilize the bought skills to the fullest.
 * [...] If there are no such moves, it's a dead end, and such purchase should
 * not be considered." 983 A: the skip for a kind a site offers within reach
 * (759) is gone with it.
 *
 * One branch for each kind the player could buy now (`buyableNow`), a unit
 * each, after `bought` earlier this turn, when one of the closest sites after
 * that purchase is a move that `usesFully` all of it. More units never make a
 * move easier to use up, so a purchase without such a move is a dead end
 * whatever follows it.
 */
export function buyBranches(
  state: GameState,
  player: PlayerState,
  bought: readonly RewardKind[],
  closestTo: (state: GameState, player: PlayerState) => readonly PoiCandidate[],
  walkRoute: RouteChoice = cheapestRoute,
): readonly MctsBranch[] {
  const branches: MctsBranch[] = [];
  for (const skill of buyableNow(state, player.id).kinds) {
    const after = applyAction(state, { kind: 'buy', player: player.id, skills: [skill] }, NO_DICE).state;
    if (after.status !== 'in_progress') continue;
    const buyer = playerById(after, player.id);
    const all = [...bought, skill];
    if (closestTo(after, buyer).some((target) => usesFully(after, buyer, target.node, all, walkRoute))) {
      branches.push({ kind: 'buy', skill });
    }
  }
  return branches;
}

/** A purchase rolls nothing; a die asked for here is a bug. */
const NO_DICE: DiceSource = {
  roll() {
    throw new RangeError('a purchase rolls no die');
  },
  pick() {
    throw new RangeError('a purchase draws nothing');
  },
};

/**
 * [Q280] Whether heading for `target` uses up everything `bought` this turn,
 * on this turn's walk along the route `walkRoute` picks, as the move walks it:
 *  - a speed: "if a movement skill was bought, the path should use it up", so
 *    the walk spends every free step on that terrain;
 *  - combat or magic: "it should arrive to face a strong enough foe", so the
 *    walk arrives this turn at an unclaimed site guarded by that skill which
 *    could beat the player on some roll before the purchase (§8: the roll
 *    plus the skill must be above the guard), and no unit bought takes the
 *    skill past the guard's strength, where every roll already wins.
 */
export function usesFully(
  state: GameState,
  player: PlayerState,
  target: NodeId,
  bought: readonly RewardKind[],
  walkRoute: RouteChoice = cheapestRoute,
): boolean {
  const units = new Map<RewardKind, number>();
  for (const kind of bought) units.set(kind, (units.get(kind) ?? 0) + 1);
  const poi = poiAt(state.map, target);
  for (const kind of units.keys()) {
    if (SPEED_TERRAIN[kind] !== undefined) continue;
    if (poi?.guard?.type !== kind) return false;
  }

  const route = walkRoute(state, player, target);
  if (route === null) return false;
  const preview = previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, state.map.ruleset.config);
  const freeSteps: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  for (const step of preview.steps) {
    if (step.color === 'free') freeSteps[terrainAt(state, step.node)]++;
  }

  for (const [kind, count] of units) {
    const terrain = SPEED_TERRAIN[kind];
    if (terrain !== undefined) {
      if (freeSteps[terrain] < state.turn.allowance[terrain]) return false;
      continue;
    }
    if (!preview.destinationReachable || poi?.guard == null) return false;
    if (state.poiRuntime[state.map.poiByNode.get(target) ?? -1]?.claimedBy !== null) return false;
    const skill = player.stats[poi.guard.type];
    if (skill - count >= poi.guard.strength || skill > poi.guard.strength) return false;
  }
  return true;
}

const SPEED_TERRAIN: Partial<Record<RewardKind, Terrain>> = { plains_move: 'plains', forest_move: 'forest', mountain_move: 'mountain' };

function terrainAt(state: GameState, node: NodeId): Terrain {
  const at = state.map.graph.nodes[node];
  if (at === undefined) throw new RangeError(`no node ${node}`);
  return at.terrain;
}

/**
 * Q65's stamina(1): what walking `steps` costs beyond this turn's free steps,
 * Σ cost × max(steps − free steps, 0) over the three terrains. Free steps go
 * first on each terrain whatever the order of the steps (§7), so this is what
 * the walk spends, and the walk arrives this turn exactly when the player
 * holds that much stamina.
 */
export function staminaBeyondThisTurn(steps: PerTerrain<number>, free: PerTerrain<number>, config: GameConfig): number {
  const cost = config.movement.STAMINA_COST;
  let stamina = 0;
  for (const terrain of TERRAINS) {
    const beyond = steps[terrain] - free[terrain];
    if (beyond > 0) stamina += cost[terrain] * beyond;
  }
  return stamina;
}

/** POIs whose reward is still unclaimed (§4.5) — the eligible target set. */
export function unclaimedPoiNodesOf(state: GameState): ReadonlySet<NodeId> {
  return unclaimedPoiNodes(state);
}

/**
 * [SOURCE §12.2, chat] "reachable in one turn": walking the cheapest route to
 * the target (the one metric, §5.1) arrives this turn, on this turn's
 * allowance and the player's stamina (§7). Standing on it already counts.
 *
 * The search before Q210's stage 2, kept to compare with; the game's is
 * `stepsReachability(bestRouteStepsFor)`.
 */
export function previewReachability(): TurnReachability {
  return {
    isReachableThisTurn(state: GameState, subject: PlayerId, target: PoiCandidate): boolean {
      const player = playerById(state, subject);
      const config = state.map.ruleset.config;
      const route = routeTable(state.map.graph, config).path(player.position, target.node);
      if (route === null) return false;
      return previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, config)
        .destinationReachable;
    },
  };
}

/**
 * [Q210, 820 A] "reachable in one turn" from the cached steps per terrain of
 * the route `stepsTo` counts, the best for the player's speeds in the game,
 * with no route traced: Andrei, 2026-10-02, "the first three items don't need
 * the path, and can use the distance provided by the formula". The walk
 * arrives this turn exactly when the player holds `staminaBeyondThisTurn` of
 * it, so this agrees with `previewPath` over the same route. Standing on the
 * target already counts.
 */
export function stepsReachability(stepsTo: RouteStepsFinder): TurnReachability {
  return {
    isReachableThisTurn(state: GameState, subject: PlayerId, target: PoiCandidate): boolean {
      const player = playerById(state, subject);
      const steps = stepsTo(state, player, target.node);
      if (steps === null) return false;
      return staminaBeyondThisTurn(steps, state.turn.allowance, state.map.ruleset.config) <= player.stats.stamina;
    },
  };
}
