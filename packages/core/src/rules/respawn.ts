import type { GameEvent } from '../action.ts';
import type { NodeId } from '../ids.ts';
import { routeTable } from '../path.ts';
import type { PoiRuntimeState } from '../poi.ts';
import type { GameState } from '../state.ts';
import type { DiceSource } from './turn.ts';

const UNCLAIMED: PoiRuntimeState = { claimedBy: null, claimedOnTurn: null };

/**
 * [Q135] Speeds and skills come back. Andrei, 2026-09-30: "Skills need to
 * respawn where there are too few of it left, randomly at POIs that were
 * offering this skill before and are far from all players."
 *
 * Run at the end of every turn, after the turn's claim (532 A). Each kind in
 * `respawn.KINDS` is counted on its own (530 A): while fewer than
 * `SHORT_BELOW_SITES` unclaimed POIs offer it (531 C; Andrei, 2026-10-01: "We
 * need two *sites* with the skill at any time, not two units of skill on the
 * map"), one claimed POI that held it gets its reward back (532 A), but no
 * more than `MAX_UNITS` units of it (Andrei, 2026-10-01: "let us cap the
 * skills to 2 units when they respawn", then "Let's change that cap to one";
 * a game started before the cap has no `MAX_UNITS` and gets the whole
 * reward). That POI is drawn with `dice.pick`
 * from the `FAR_SHARE` of the candidates, rounded up, that are farthest from
 * their nearest figure (533 A), by the cheapest route's stamina cost (534 A),
 * never one a figure stands on. A POI that came back can be claimed and come
 * back again (535 A).
 *
 * A map without `respawn` config (a game started before this rule) is left as
 * it is. Nothing is drawn unless a kind is short and has a POI to come back
 * to, so a game where nothing runs short draws exactly the dice it did before.
 */
export function respawnShortRewards(state: GameState, dice: DiceSource, events: GameEvent[]): GameState {
  const config = state.map.ruleset.config;
  const respawn = config.respawn;
  if (respawn === undefined || respawn.KINDS.length === 0) return state;

  const pois = state.map.pois;
  const left = new Map<string, number>();
  for (let index = 0; index < pois.length; index++) {
    const poi = pois[index];
    if (poi === undefined || state.poiRuntime[index]?.claimedBy !== null) continue;
    left.set(poi.reward.kind, (left.get(poi.reward.kind) ?? 0) + 1);
  }

  let runtime: PoiRuntimeState[] | null = null;
  const occupied = new Set<NodeId>(state.players.map((player) => player.position));
  for (const kind of respawn.KINDS) {
    if ((left.get(kind) ?? 0) >= respawn.SHORT_BELOW_SITES) continue;

    const empty: { readonly index: number; readonly node: NodeId }[] = [];
    for (let index = 0; index < pois.length; index++) {
      const poi = pois[index];
      if (poi === undefined || poi.reward.kind !== kind || occupied.has(poi.node)) continue;
      if (state.poiRuntime[index]?.claimedBy === null) continue;
      empty.push({ index, node: poi.node });
    }
    if (empty.length === 0) continue;

    const table = routeTable(state.map.graph, config);
    const searches = [...occupied].map((from) => table.from(from).costs);
    const distance = (node: NodeId): number => Math.min(...searches.map((costs) => costs[node] ?? Number.POSITIVE_INFINITY));
    const ranked = empty
      .map((site) => ({ ...site, distance: distance(site.node) }))
      // Farthest first; the node id settles a tie, so the order, and with it
      // what a pick means, is the same wherever the turn is played.
      .sort((a, b) => b.distance - a.distance || a.node - b.node);
    const far = ranked.slice(0, Math.ceil(ranked.length * respawn.FAR_SHARE));
    const chosen = far[dice.pick(far.length)];
    if (chosen === undefined) continue;

    const original = pois[chosen.index]?.reward;
    if (original === undefined) continue;
    const units = respawn.MAX_UNITS === undefined ? original.units : Math.min(original.units, respawn.MAX_UNITS);
    runtime ??= state.poiRuntime.slice();
    runtime[chosen.index] = units < original.units ? { ...UNCLAIMED, units } : UNCLAIMED;
    events.push({ type: 'reward_returned', node: chosen.node, reward: { kind: original.kind, units } });
  }

  return runtime === null ? state : { ...state, poiRuntime: runtime };
}
