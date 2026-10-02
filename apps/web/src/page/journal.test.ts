import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET, RESPAWN_RULES, type RewardKind, type Terrain } from '@adventure/config';
import {
  applyAction,
  asGameId,
  asNodeId,
  asPlayerId,
  createGameState,
  refreshAllowance,
  type DiceSource,
  type GameMap,
  type GameState,
  type Guard,
  type NodeId,
  type PlayerState,
  type PlayerStats,
  type TurnAction,
} from '@adventure/core';
import { playedTurnOf, purchaseOf, type PlayedTurn, type Purchase } from '../modes/hotseat.ts';
import { journalEntry, purchaseEntry, statLine } from './journal.ts';

/**
 * §8's map, as the rules tests draw it: five plains, a forest and a mountain in
 * a line, 3 gold behind a fighting guard of 5 on the forest node and 5 gold
 * unguarded on the mountain.
 *
 *   0(p) ── 1(p) ── 2(p) ── 3(p) ── 4(p) ── 5(f) ── 6(m)
 */
function lineMap(terrains: readonly Terrain[], pois: readonly { node: number; kind: RewardKind; units: number; guard: Guard | null }[]): GameMap {
  const n = asNodeId;
  const edges = terrains.slice(1).map((_terrain, index) => ({ a: n(index), b: n(index + 1) }));
  const placed = pois.map((poi) => ({
    node: n(poi.node),
    terrain: terrains[poi.node] as Terrain,
    reward: { kind: poi.kind, units: poi.units },
    guard: poi.guard,
    remoteness: 0.5,
    group: { kind: poi.kind, guard: poi.guard?.type ?? null },
    artVariant: 0,
  }));
  return {
    seed: 'journal',
    ruleset: DEFAULT_RULESET,
    graph: {
      nodes: terrains.map((terrain, index) => ({ id: n(index), position: { x: index, y: 0 }, terrain })),
      edges,
      adjacency: terrains.map((_terrain, index) => [index - 1, index + 1].filter((next) => next >= 0 && next < terrains.length).map(n)),
    },
    pois: placed,
    poiByNode: new Map(placed.map((poi, index) => [poi.node, index])),
    attempts: 1,
  };
}

const map = lineMap(
  ['plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'mountain'],
  [
    { node: 5, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 5 } },
    { node: 6, kind: 'gold', units: 5, guard: null },
  ],
);

function game(stats: Partial<PlayerStats>): GameState {
  const state = createGameState({
    id: asGameId('journal'),
    map,
    players: ['Ada', 'Bram'].map((name) => ({ id: asPlayerId(name), name, avatarId: name, control: 'human' as const })),
    startingNode: asNodeId(0),
  });
  const [ada, bram] = state.players as [PlayerState, PlayerState];
  const moved = { ...ada, stats: { ...ada.stats, ...stats } };
  return { ...state, players: [moved, bram], turn: { ...state.turn, allowance: refreshAllowance(moved.stats) } };
}

function dice(...values: number[]): DiceSource {
  return { roll: () => ({ value: values.shift() ?? 1, sides: 6 }), pick: () => 0 };
}

type Plan = { readonly kind: 'move'; readonly path: readonly NodeId[] } | { readonly kind: 'rest' };

/** Play `plan` from `before` for the player whose turn it is, and describe it. */
function describeTurn(before: GameState, plan: Plan, roll: DiceSource = dice()) {
  const player = before.players[before.turn.activeSeat - 1] as PlayerState;
  const action: TurnAction = plan.kind === 'move' ? { kind: 'move', player: player.id, path: plan.path } : { kind: 'rest', player: player.id };
  const outcome = applyAction(before, action, roll);
  const turn: PlayedTurn = {
    number: before.turn.number,
    seat: player.seat,
    player: player.id,
    name: player.name,
    action,
    events: outcome.events,
    positionBefore: player.position,
    allowanceBefore: before.turn.allowance,
    statsBefore: player.stats,
    after: outcome.state,
    bought: [],
  };
  return journalEntry(turn, before);
}

const path = (...nodes: number[]) => nodes.map(asNodeId);

describe('the turn log, in words that can be checked by hand', () => {
  const workedExample = { stamina: 14, plains_move: 3, forest_move: 1, mountain_move: 0, fighting: 2 };

  it('reads §8’s worked example step by step', () => {
    const entry = describeTurn(game(workedExample), { kind: 'move', path: path(1, 2, 3, 4, 5) }, dice(4));
    expect(entry.headline).toBe('Walked 5 steps, beat the guard and took 3 gold');
    expect(entry.details).toEqual([
      'Heading for the 3 gold site (forest, combat guard 5).',
      'Steps: plains free ×3 · plains 1 stamina · forest free.',
      'Stamina 14 → 13.',
      'Combat guard 5: rolled 4 + combat 2 = 6, more than 5. Took 3 gold.',
    ]);
    expect(entry.tone).toBe('took');
    expect(statLine(entry.statsAfter)).toBe(
      'stamina 13 · plains speed 3 · forest speed 1 · mountains speed 0 · combat 2 · magic 0 · gold 3',
    );
  });

  it('says a roll that only ties the guard loses, and that the reward stays', () => {
    const entry = describeTurn(game(workedExample), { kind: 'move', path: path(1, 2, 3, 4, 5) }, dice(3));
    expect(entry.headline).toBe('Walked 5 steps, lost to the guard');
    expect(entry.details.at(-1)).toBe(
      'Combat guard 5: rolled 3 + combat 2 = 5, not more than 5. The gold stays.',
    );
    expect(entry.tone).toBe('missed');
  });

  it('names the step a walk could not pay for, and what was saved', () => {
    const entry = describeTurn(game({ stamina: 2 }), { kind: 'move', path: path(1, 2, 3, 4, 5, 6) });
    expect(entry.headline).toBe('Walked 2 of 6 steps');
    expect(entry.details).toEqual([
      'Heading for the 5 gold site (mountain).',
      'Steps: plains 1 stamina ×2.',
      'Stamina 2 → 0.',
      'Stopped: the next step, into plains, costs 1 stamina and 0 are left (plains speed is 0). Those 4 steps are saved for next turn.',
    ]);
  });

  it('says so when not even the first step was affordable', () => {
    const entry = describeTurn(game({ stamina: 0, plains_move: 1 }), { kind: 'move', path: path(1, 2) });
    expect(entry.headline).toBe('Walked 1 of 2 steps');
    expect(entry.details.at(-1)).toBe(
      'Stopped: the next step, into plains, costs 1 stamina and 0 are left (plains speed 1, all 1 free step used). That last step is saved for next turn.',
    );
    const none = describeTurn(game({ stamina: 0 }), { kind: 'move', path: path(1) });
    expect(none.headline).toBe('Could not afford the first step');
  });

  it('calls a place with no site a space, as the rulebook does (Andrei, 2026-09-29, 370)', () => {
    const entry = describeTurn(game({ stamina: 20 }), { kind: 'move', path: path(1, 2, 3) });
    expect(entry.details[0]).toBe('Heading for a plains space.');
  });

  it('writes a rest as the stamina it gained', () => {
    const entry = describeTurn(game({ stamina: 7 }), { kind: 'rest' });
    expect(entry.headline).toBe(`Rested: +${DEFAULT_RULESET.config.movement.REST_STAMINA_GAIN} stamina`);
    expect(entry.details[0]).toContain(`Stamina 7 → ${7 + DEFAULT_RULESET.config.movement.REST_STAMINA_GAIN}.`);
  });

  it('says where a skill came back, by its site’s terrain (Q135, 536)', () => {
    // Combat on nodes 2 and 5; Ada takes node 2's, the last left, and node 5,
    // taken earlier, comes back: with 1 of its 3, all a site comes back with.
    // Only games started before buying (Q190, 757) bring skills back.
    const { buying: _buying, ...config } = DEFAULT_RULESET.config;
    const today = lineMap(
      ['plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'mountain'],
      [
        { node: 2, kind: 'fighting', units: 1, guard: null },
        { node: 5, kind: 'fighting', units: 3, guard: null },
      ],
    );
    const skills: GameMap = { ...today, ruleset: { ...today.ruleset, config: { ...config, respawn: RESPAWN_RULES } } };
    const fresh = createGameState({
      id: asGameId('journal'),
      map: skills,
      players: ['Ada', 'Bram'].map((name) => ({ id: asPlayerId(name), name, avatarId: name, control: 'human' as const })),
      startingNode: asNodeId(0),
    });
    const before = { ...fresh, poiRuntime: [fresh.poiRuntime[0]!, { claimedBy: asPlayerId('Bram'), claimedOnTurn: 1 }] };
    const entry = describeTurn(before, { kind: 'move', path: path(1, 2) });
    expect(entry.details.at(-1)).toBe('1 combat came back at a forest site.');
  });

  it('gives each Done in the buy panel a line, before the move (Q190, 769)', () => {
    let state = game({ gold: 4 });
    const ada = state.players[0]!.id;
    const bought: Purchase[] = [];
    for (const skills of [['mountain_move', 'fighting', 'mountain_move'], ['magic']] as const) {
      const action = { kind: 'buy', player: ada, skills } as const;
      const outcome = applyAction(state, action, dice());
      bought.push(purchaseOf(state, action, outcome.events, outcome.state, bought));
      state = outcome.state;
    }
    const rest = { kind: 'rest', player: ada } as const;
    const outcome = applyAction(state, rest, dice());
    const entry = journalEntry(playedTurnOf(state, rest, outcome.events, outcome.state, bought), state);
    expect(entry.details.slice(0, 2)).toEqual(['Ada bought 2 mountains speed and 1 combat for 3 gold.', 'Ada bought 1 magic for 1 gold.']);
    expect(entry.headline).toBe('Rested: +5 stamina');
  });

  it('gives a purchase that hands another player the win an entry of its own (Q190, 756)', () => {
    // 8 gold on the map; Bram has 6 and Ada 1, then Ada spends hers: 6 − 0 is not more than 8, so take some away.
    const start = game({ gold: 1 });
    const rich = { ...start, poiRuntime: start.poiRuntime.map((runtime, index) => (index === 0 ? { claimedBy: asPlayerId('Bram'), claimedOnTurn: 1 } : runtime)), players: start.players.map((player) => (player.name === 'Bram' ? { ...player, stats: { ...player.stats, gold: 6 } } : player)) };
    const action = { kind: 'buy', player: rich.players[0]!.id, skills: ['magic'] } as const;
    const outcome = applyAction(rich, action, dice());
    const entry = purchaseEntry(purchaseOf(rich, action, outcome.events, outcome.state));
    expect(entry.tone).toBe('won');
    expect(entry.details).toEqual([
      'Ada bought 1 magic for 1 gold.',
      'Bram wins: 6 gold, 6 ahead of Ada, with 5 gold left on the map — a lead nobody can catch.',
    ]);
  });

  it('writes the winning claim with the lead and the gold left', () => {
    // Ada takes the unguarded 5 gold; 3 are left and Bram has none, so 5 − 0 > 3.
    const entry = describeTurn(game({ stamina: 20 }), { kind: 'move', path: path(1, 2, 3, 4, 5, 6) });
    expect(entry.tone).toBe('won');
    expect(entry.details.at(-1)).toBe('Ada wins: 5 gold, 5 ahead of Bram, with 3 gold left on the map — a lead nobody can catch.');
  });
});
