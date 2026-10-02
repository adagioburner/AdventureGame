import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, startingGoldOf, startingStaminaForSeat } from '@adventure/config';
import { RuleViolationError } from '../errors.ts';
import { asGameId, asPlayerId } from '../ids.ts';
import { createGameState } from './setup.ts';
import { fixtureGame, fixtureMap, n } from './scenario.fixture.ts';

const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
  ],
  pois: [{ node: 2, kind: 'gold', units: 3, guard: null }],
});

describe('createGameState', () => {
  const state = fixtureGame(map, 0, ['one', 'two', 'three']);

  it('seats players in the order it is given them, seat 1 first to move', () => {
    expect(state.players.map((current) => current.seat)).toEqual([1, 2, 3]);
    expect(state.turn.activeSeat).toBe(1);
    expect(state.turn.number).toBe(1);
    expect(state.status).toBe('in_progress');
  });

  it('starts every seat on the one shared node', () => {
    // [SOURCE §6, chat] "All players start from the same spot."
    expect(state.players.map((current) => current.position)).toEqual([n(0), n(0), n(0)]);
  });

  it('gives every seat the same starting gold, 5, in a game started since players began with gold (Q200)', () => {
    const started = createGameState({
      id: asGameId('gold'),
      map: { ...map, ruleset: DEFAULT_RULESET },
      players: ['one', 'two', 'three'].map((name) => ({ id: asPlayerId(name), name, avatarId: `avatar-${name}`, control: 'human' as const })),
      startingNode: n(0),
    });
    expect(startingGoldOf(DEFAULT_RULESET)).toBe(5);
    expect(started.players.map((current) => current.stats.gold)).toEqual([5, 5, 5]);
  });

  it('gives no gold in a game whose map has no starting gold, one started before (Q200, 790)', () => {
    expect(map.ruleset.config.players.STARTING_GOLD).toBeUndefined();
    expect(state.players.map((current) => current.stats.gold)).toEqual([0, 0, 0]);
  });

  it('gives a later seat more starting stamina, and every other stat zero', () => {
    expect(state.players.map((current) => current.stats.stamina)).toEqual([
      startingStaminaForSeat(1, DEFAULT_RULESET),
      startingStaminaForSeat(2, DEFAULT_RULESET),
      startingStaminaForSeat(3, DEFAULT_RULESET),
    ]);
    expect(state.players[0]?.stats).toMatchObject({
      plains_move: 0,
      forest_move: 0,
      mountain_move: 0,
      fighting: 0,
      magic: 0,
      gold: 0,
    });
  });

  it('opens with the first seat’s allowance, which is nothing at all', () => {
    expect(state.turn.allowance).toEqual({ plains: 0, forest: 0, mountain: 0 });
  });

  it('starts every POI unclaimed, one runtime entry per POI', () => {
    expect(state.poiRuntime).toEqual(map.pois.map(() => ({ claimedBy: null, claimedOnTurn: null })));
  });

  it('starts with an empty board and no winners', () => {
    expect(state.messageBoard).toEqual([]);
    expect(state.winners).toEqual([]);
  });

  it('refuses a player count outside PLAYER_COUNT', () => {
    const solitaire = () =>
      createGameState({
        id: asGameId('fixture'),
        map,
        players: [{ id: asPlayerId('one'), name: 'one', avatarId: 'a', control: 'human' }],
        startingNode: n(0),
      });
    expect(solitaire).toThrow(RuleViolationError);
  });
});
