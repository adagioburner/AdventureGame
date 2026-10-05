import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import type { GameMap } from '../gamemap.ts';
import { RuleViolationError } from '../errors.ts';
import { playerById, type GameState } from '../state.ts';
import { applyAction, buyableNow } from './turn.ts';
import { fixtureGame, fixtureMap, n, noDice, player, withStats } from './scenario.fixture.ts';

/**
 * [Q190] Andrei, 2026-10-02: "allow players buy skills for gold, 1 to 1." On
 * their own turn (754) a player buys a speed, combat or magic (753) for 1 gold
 * a unit, as often as their gold pays for (751); the turn goes on. A speed
 * bought counts this turn (752). Spent gold leaves the game, and a purchase
 * runs §1's win check (756).
 *
 *   0(p) ── 1(p) ── 2(f) ── 3(m)
 *                            │
 *                            4(p): 3 gold, unguarded
 */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'forest', 'mountain', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  pois: [{ node: 4, kind: 'gold', units: 3, guard: null }],
});

const one = player('one');
const two = player('two');

function game(gold = 2): GameState {
  return withStats(fixtureGame(map, 0), one, { gold });
}

describe('buying a speed or skill (Q190)', () => {
  it('takes 1 gold for 1 unit and leaves the turn with the buyer', () => {
    const { state, events } = applyAction(game(), { kind: 'buy', player: one, skills: ['fighting'] }, noDice);
    expect(playerById(state, one).stats.fighting).toBe(1);
    expect(playerById(state, one).stats.gold).toBe(1);
    expect(state.turn).toEqual({ ...game().turn });
    expect(events).toEqual([{ type: 'bought', player: one, skills: ['fighting'], gold: 1 }]);
  });

  it('buys everything picked before Done in one purchase, or nothing if the gold falls short (768)', () => {
    const { state, events } = applyAction(game(3), { kind: 'buy', player: one, skills: ['mountain_move', 'fighting', 'fighting'] }, noDice);
    expect(playerById(state, one).stats).toMatchObject({ mountain_move: 1, fighting: 2, gold: 0 });
    expect(state.turn.allowance.mountain).toBe(1);
    expect(events).toEqual([{ type: 'bought', player: one, skills: ['mountain_move', 'fighting', 'fighting'], gold: 3 }]);
    expect(() => applyAction(game(2), { kind: 'buy', player: one, skills: ['magic', 'magic', 'magic'] }, noDice)).toThrow(RuleViolationError);
    expect(() => applyAction(game(2), { kind: 'buy', player: one, skills: [] }, noDice)).toThrow(RuleViolationError);
  });

  it('buys as many units as the gold pays for, then refuses (751)', () => {
    let state = game(2);
    state = applyAction(state, { kind: 'buy', player: one, skills: ['magic'] }, noDice).state;
    state = applyAction(state, { kind: 'buy', player: one, skills: ['magic'] }, noDice).state;
    expect(playerById(state, one).stats.magic).toBe(2);
    expect(playerById(state, one).stats.gold).toBe(0);
    expect(() => applyAction(state, { kind: 'buy', player: one, skills: ['magic'] }, noDice)).toThrow(RuleViolationError);
  });

  it('gives a speed bought its free step this turn too (752)', () => {
    const { state } = applyAction(game(), { kind: 'buy', player: one, skills: ['forest_move'] }, noDice);
    expect(state.turn.allowance).toEqual({ plains: 0, forest: 1, mountain: 0 });
    // The forest step from 1 to 2 is free now: only the plains step to 1 costs stamina.
    const walked = applyAction(state, { kind: 'move', player: one, path: [n(1), n(2)] }, noDice).state;
    const stamina = playerById(state, one).stats.stamina;
    expect(playerById(walked, one).stats.stamina).toBe(stamina - 1);
  });

  it('never buys stamina or gold (753)', () => {
    expect(() => applyAction(game(), { kind: 'buy', player: one, skills: ['stamina'] }, noDice)).toThrow(RuleViolationError);
    expect(() => applyAction(game(), { kind: 'buy', player: one, skills: ['gold'] }, noDice)).toThrow(RuleViolationError);
  });

  it('is only for the player on turn (754)', () => {
    const rich = withStats(game(), two, { gold: 3 });
    expect(() => applyAction(rich, { kind: 'buy', player: two, skills: ['fighting'] }, noDice)).toThrow(RuleViolationError);
    expect(buyableNow(rich, two).kinds).toEqual([]);
  });

  it('lists the five skills while the buyer has the gold for one', () => {
    expect(buyableNow(game(1), one)).toEqual({ kinds: ['plains_move', 'forest_move', 'mountain_move', 'fighting', 'magic'], price: 1 });
    expect(buyableNow(game(0), one).kinds).toEqual([]);
  });

  it('hands another player the win when spending puts their lead past the gold left (756)', () => {
    // 3 gold left on the map. Two leads one by 3, not more than 3; one buys, and two leads by 4.
    const state = withStats(withStats(game(1), two, { gold: 4 }), one, { gold: 1 });
    const { state: after, events } = applyAction(state, { kind: 'buy', player: one, skills: ['magic'] }, noDice);
    expect(after.status).toBe('finished');
    expect(after.winners).toEqual([two]);
    expect(events.map((event) => event.type)).toEqual(['bought', 'game_won']);
  });
});
