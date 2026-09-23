import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET, type RewardKind, type Terrain } from '@adventure/config';
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
import type { PlayedTurn } from '../modes/hotseat.ts';
import { journalEntry, statLine } from './journal.ts';

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
  return { roll: () => ({ value: values.shift() ?? 1, sides: 6 }) };
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
      'Heading for the 3 gold POI (forest, combat guard 5).',
      'Steps: plains free ×3 · plains 1 stamina · forest free.',
      'Stamina 14 → 13.',
      'Combat guard 5: rolled 4 + combat 2 = 6, more than 5. Took 3 gold.',
    ]);
    expect(entry.tone).toBe('took');
    expect(statLine(entry.statsAfter)).toBe(
      'stamina 13 · gold 3 · plains speed 3 · forest speed 1 · mountains speed 0 · combat 2 · magic 0',
    );
  });

  it('says a roll that only ties the guard loses, and that losing costs nothing else', () => {
    const entry = describeTurn(game(workedExample), { kind: 'move', path: path(1, 2, 3, 4, 5) }, dice(3));
    expect(entry.headline).toBe('Walked 5 steps, lost to the guard');
    expect(entry.details.at(-1)).toBe(
      'Combat guard 5: rolled 3 + combat 2 = 5, not more than 5. The gold stays; losing costs nothing else.',
    );
    expect(entry.tone).toBe('missed');
  });

  it('names the step a walk could not pay for, and what was saved', () => {
    const entry = describeTurn(game({ stamina: 2 }), { kind: 'move', path: path(1, 2, 3, 4, 5, 6) });
    expect(entry.headline).toBe('Walked 2 of 6 steps');
    expect(entry.details).toEqual([
      'Heading for the 5 gold POI (mountain).',
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

  it('writes a rest as the stamina it gained', () => {
    const entry = describeTurn(game({ stamina: 7 }), { kind: 'rest' });
    expect(entry.headline).toBe(`Rested: +${DEFAULT_RULESET.config.movement.REST_STAMINA_GAIN} stamina`);
    expect(entry.details[0]).toContain(`Stamina 7 → ${7 + DEFAULT_RULESET.config.movement.REST_STAMINA_GAIN}.`);
  });

  it('writes the winning claim with the lead and the gold left', () => {
    // Ada takes the unguarded 5 gold; 3 are left and Bram has none, so 5 − 0 > 3.
    const entry = describeTurn(game({ stamina: 20 }), { kind: 'move', path: path(1, 2, 3, 4, 5, 6) });
    expect(entry.tone).toBe('won');
    expect(entry.details.at(-1)).toBe('Ada wins: 5 gold, 5 ahead of Bram, with 3 gold left on the map — a lead nobody can catch.');
  });
});
