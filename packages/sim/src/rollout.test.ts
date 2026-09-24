import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type GameConfig } from '@adventure/config';
import { applyAction, createDiceSource, createRng, poiRuntimeAt, unclaimedGoldUnits, type GameState } from '@adventure/core';
import {
  fixtureGame,
  fixtureMap,
  n,
  player,
  scriptedDice,
  withPosition,
  withStats,
} from '../../core/src/rules/scenario.fixture.ts';
import {
  goldExhaustedTermination,
  macroAdvanceToTarget,
  playRolloutTurn,
  playUntilTurnOf,
  rolloutCursor,
  runRollout,
  turnTowards,
  unclaimedPoiNodes,
  type RestRule,
  type RolloutOptions,
} from './rollout.ts';

/**
 * A rule for these tests only: rest when not a single step can be paid.
 * Which rule the game uses is the designer's to pick, so none ships as a
 * default and the tests do not assume one.
 */
const restWhenStuck: RestRule = {
  name: 'test: rest when stuck',
  restsInstead: (_state, _player, _route, preview) => preview.reachableStepCount === 0,
};
const neverRest: RestRule = { name: 'test: never rest', restsInstead: () => false };

function withK(k: number): GameConfig {
  return { ...DEFAULT_GAME_CONFIG, balancing: { ...DEFAULT_GAME_CONFIG.balancing, CLOSE_CANDIDATE_COUNT: k } };
}

function options(overrides: Partial<RolloutOptions> = {}): RolloutOptions {
  return {
    config: withK(1),
    termination: goldExhaustedTermination(),
    restRule: restWhenStuck,
    dice: createDiceSource(createRng('dice'), DEFAULT_GAME_CONFIG),
    rng: createRng('rollout'),
    ...overrides,
  };
}

/**
 * 0 ─ 1 ─ 2 ─ 3 ─ 4 ─ 5 ─ 6, all plains, so cost is the hop count.
 * Gold 1 on 5, gold 3 on 6 (so one claim cannot decide the game), a fighting
 * skill on 1 and a stamina POI on 2.
 */
const line = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ],
  pois: [
    { node: 1, kind: 'fighting', units: 1, guard: null },
    { node: 2, kind: 'stamina', units: 1, guard: null },
    { node: 5, kind: 'gold', units: 1, guard: null },
    { node: 6, kind: 'gold', units: 3, guard: null },
  ],
});

/** Seat one to move, both players with no free steps and no stamina. */
function stuckGame(): GameState {
  let state = fixtureGame(line, 0);
  state = withStats(state, player('two'), { stamina: 0 });
  return withStats(state, player('one'), { stamina: 0 });
}

describe('unclaimedPoiNodes', () => {
  it('lists every POI until it is claimed, then drops it', () => {
    const state = fixtureGame(line, 0);
    expect([...unclaimedPoiNodes(state)].sort((a, b) => a - b)).toEqual([n(1), n(2), n(5), n(6)]);

    const claimed = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, scriptedDice([])).state;
    expect([...unclaimedPoiNodes(claimed)].sort((a, b) => a - b)).toEqual([n(2), n(5), n(6)]);
  });
});

describe('turnTowards', () => {
  it('commits the whole cheapest route and lets §7 cut it short', () => {
    const state = withStats(fixtureGame(line, 0), player('one'), { stamina: 2 });
    expect(turnTowards(state, n(5), neverRest)).toEqual({
      kind: 'move',
      player: player('one'),
      path: [n(1), n(2), n(3), n(4), n(5)],
      waypoint: null,
    });
  });

  it('is the empty move when the player already stands on the target', () => {
    const state = withPosition(fixtureGame(line, 0), player('one'), 5);
    expect(turnTowards(state, n(5), neverRest)).toEqual({ kind: 'move', player: player('one'), path: [], waypoint: null });
  });

  it('asks the rest rule, with this turn’s preview of the route', () => {
    expect(turnTowards(stuckGame(), n(5), restWhenStuck)).toEqual({ kind: 'rest', player: player('one') });
    const able = withStats(stuckGame(), player('one'), { stamina: 1 });
    expect(turnTowards(able, n(5), restWhenStuck).kind).toBe('move');
  });
});

describe('playRolloutTurn', () => {
  it('keeps each seat’s target across the other seats’ turns, and drops it on arrival', () => {
    // Seat one walks one plains step a turn; its target is 5, four steps on.
    let cursor = rolloutCursor(withStats(stuckGame(), player('one'), { plains_move: 1 }), player('one'));
    cursor = { ...cursor, targets: [n(5), null] };

    cursor = playRolloutTurn(cursor, options());
    expect(cursor.state.players[0]?.position).toBe(n(1));
    expect(cursor.targets[0]).toBe(n(5));

    // Seat two, stuck, picks its closest unclaimed POI (K = 1) and rests.
    cursor = playRolloutTurn(cursor, options());
    expect(cursor.targets[0]).toBe(n(5));
    expect(cursor.targets[1]).toBe(n(2));
    expect(cursor.state.players[1]?.stats.stamina).toBe(DEFAULT_GAME_CONFIG.movement.REST_STAMINA_GAIN);
  });

  it('drops a target someone else has just claimed', () => {
    const state = withStats(withPosition(stuckGame(), player('two'), 4), player('two'), { stamina: 5 });
    let cursor = rolloutCursor(state, player('one'));
    cursor = { ...cursor, targets: [n(5), n(5)] };
    const restingOne = playRolloutTurn(cursor, options({ restRule: { name: 'rest', restsInstead: () => true } }));
    const afterTwo = playRolloutTurn(restingOne, options({ restRule: neverRest }));
    expect(poiRuntimeAt(afterTwo.state, n(5))?.claimedBy).toBe(player('two'));
    expect(afterTwo.targets).toEqual([null, null]);
  });
});

describe('macroAdvanceToTarget', () => {
  it('arrives, with §8’s interaction resolved', () => {
    const state = withStats(fixtureGame(line, 0), player('one'), { stamina: 10 });
    const { cursor, outcome } = macroAdvanceToTarget(rolloutCursor(state, player('one')), n(5), options());
    expect(outcome).toBe('arrived');
    expect(cursor.state.players[0]?.position).toBe(n(5));
    expect(poiRuntimeAt(cursor.state, n(5))?.claimedBy).toBe(player('one'));
  });

  it('arrives at a guarded POI it fails to take, which stays unclaimed', () => {
    const guarded = fixtureMap({
      terrains: ['plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [1, 2],
      ],
      pois: [
        { node: 1, kind: 'gold', units: 1, guard: { type: 'fighting', strength: 5 } },
        { node: 2, kind: 'gold', units: 1, guard: null },
      ],
    });
    const state = withStats(fixtureGame(guarded, 0), player('one'), { stamina: 10 });
    const { cursor, outcome } = macroAdvanceToTarget(
      rolloutCursor(state, player('one')),
      n(1),
      options({ dice: scriptedDice([2]) }),
    );
    expect(outcome).toBe('arrived');
    expect(poiRuntimeAt(cursor.state, n(1))?.claimedBy).toBeNull();
  });

  it('reports target_claimed_by_other when the target is taken from under it', () => {
    // Seat one is four steps from 5 at one step a turn; seat two stands next
    // to it, heads for it (K = 1) and takes it on its first turn.
    let state = withStats(stuckGame(), player('one'), { plains_move: 1 });
    state = withStats(withPosition(state, player('two'), 4), player('two'), { stamina: 5 });
    const { cursor, outcome } = macroAdvanceToTarget(rolloutCursor(state, player('one')), n(5), options());
    expect(outcome).toBe('target_claimed_by_other');
    expect(cursor.state.players[0]?.position).toBe(n(1));
    expect(poiRuntimeAt(cursor.state, n(5))?.claimedBy).toBe(player('two'));
    expect(cursor.state.status).toBe('in_progress');
  });

  it('reports terminal when the game ends on the way', () => {
    const state = withStats(fixtureGame(line, 0), player('one'), { stamina: 10 });
    const decided = { ...state, status: 'finished' as const };
    expect(macroAdvanceToTarget(rolloutCursor(decided, player('one')), n(5), options()).outcome).toBe('terminal');
  });
});

describe('playUntilTurnOf', () => {
  it('plays the other seats until the named player is to move', () => {
    const state = applyAction(stuckGame(), { kind: 'rest', player: player('one') }, scriptedDice([])).state;
    const back = playUntilTurnOf(rolloutCursor(state, player('one')), player('one'), options());
    expect(back.state.turn.activeSeat).toBe(1);
    expect(back.state.turn.number).toBe(3);
  });
});

describe('runRollout', () => {
  it('stops once no gold is left, with skill and stamina POIs still on the map', () => {
    // K = 1 sends everyone to the nearest unclaimed POI, so the fighting and
    // stamina POIs are passed over only because gold ran out first: start
    // both players at 5, beside the gold and away from the rest.
    let state = withPosition(withPosition(fixtureGame(line, 0), player('one'), 5), player('two'), 5);
    state = withStats(state, player('one'), { stamina: 10 });
    const end = runRollout(rolloutCursor(state, player('one')), options());
    expect(unclaimedGoldUnits(end.state)).toBe(0);
    expect(poiRuntimeAt(end.state, n(1))?.claimedBy).toBeNull();
    expect(poiRuntimeAt(end.state, n(2))?.claimedBy).toBeNull();
  });

  it('plays whole games to the end from the opening, on random choices', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const end = runRollout(
        rolloutCursor(fixtureGame(line, 0), player('one')),
        options({ config: DEFAULT_GAME_CONFIG, rng: createRng(seed), dice: createDiceSource(createRng(seed), DEFAULT_GAME_CONFIG) }),
      );
      expect(goldExhaustedTermination().isTerminal(end, 0)).toBe(true);
    }
  });

  it('is reproducible from its seeds', () => {
    const play = () =>
      runRollout(
        rolloutCursor(fixtureGame(line, 3), player('one')),
        options({ config: DEFAULT_GAME_CONFIG, rng: createRng('same'), dice: createDiceSource(createRng('same'), DEFAULT_GAME_CONFIG) }),
      ).state;
    expect(play()).toEqual(play());
  });
});
