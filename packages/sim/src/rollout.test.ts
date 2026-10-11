import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type GameConfig } from '@adventure/config';
import {
  applyAction,
  createDiceSource,
  createRng,
  poiRuntimeAt,
  unclaimedGoldUnits,
  type GameMap,
  type GameState,
  type PlayerState,
  type PlayerStats,
} from '@adventure/core';
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
  cheapestRoute,
  closestWinnableBySpeeds,
  goldExhaustedTermination,
  macroAdvanceToTarget,
  playRolloutTurn,
  playUntilTurnOf,
  restWhenStuck,
  rolloutCursor,
  runRollout,
  turnCapTermination,
  turnTowards,
  unclaimedPoiNodes,
  winnableBySkill,
  winnablePoiNodes,
  type RestRule,
  type RolloutOptions,
} from './rollout.ts';
import { closestBySpeeds } from './speeds.ts';

const restRule = restWhenStuck();
const neverRest: RestRule = { name: 'test: never rest', restsInstead: () => false };

function withK(k: number): GameConfig {
  return { ...DEFAULT_GAME_CONFIG, balancing: { ...DEFAULT_GAME_CONFIG.balancing, CLOSE_CANDIDATE_COUNT: k } };
}

function options(overrides: Partial<RolloutOptions> = {}): RolloutOptions {
  return {
    config: withK(1),
    termination: goldExhaustedTermination(),
    restRule,
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
function stuckGame(map: GameMap = line): GameState {
  let state = fixtureGame(map, 0);
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

describe('winnablePoiNodes (detail 419, comparison only)', () => {
  const guarded = fixtureMap({
    terrains: ['plains', 'plains', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    pois: [
      { node: 1, kind: 'fighting', units: 1, guard: null },
      { node: 2, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 6 } },
      { node: 3, kind: 'gold', units: 3, guard: { type: 'magic', strength: 7 } },
    ],
  });
  const seatOne = (state: GameState) => state.players[0]!;

  it('leaves out gold whose guard a 6 plus the skill does not beat', () => {
    const state = fixtureGame(guarded, 0);
    expect([...winnablePoiNodes(state, seatOne(state))]).toEqual([n(1)]);
    const fighter = withStats(state, player('one'), { fighting: 1 });
    expect([...winnablePoiNodes(fighter, seatOne(fighter))]).toEqual([n(1), n(2)]);
    const mage = withStats(state, player('one'), { magic: 2 });
    expect([...winnablePoiNodes(mage, seatOne(mage))]).toEqual([n(1), n(3)]);
  });

  it('falls back to every unclaimed POI when nothing is winnable', () => {
    const state = fixtureGame(guarded, 0);
    const claimed = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, scriptedDice([])).state;
    expect([...winnablePoiNodes(claimed, claimed.players[1]!)]).toEqual([n(2), n(3)]);
  });
});

describe('winnableBySkill (Q295: the sites imagined players head for)', () => {
  const guarded = fixtureMap({
    terrains: ['plains', 'plains', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    pois: [
      { node: 1, kind: 'fighting', units: 1, guard: null },
      { node: 2, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 6 } },
      { node: 3, kind: 'gold', units: 3, guard: { type: 'magic', strength: 7 } },
    ],
  });
  const seatOne = (state: GameState) => state.players[0]!;

  it('leaves out gold whose guard a 6 plus the skill does not beat, whatever gold the player holds', () => {
    const state = withStats(fixtureGame(guarded, 0), player('one'), { gold: 9 });
    expect([...winnableBySkill(state, seatOne(state))]).toEqual([n(1)]);
    const fighter = withStats(state, player('one'), { fighting: 1 });
    expect([...winnableBySkill(fighter, seatOne(fighter))]).toEqual([n(1), n(2)]);
  });

  it('leaves nothing when nothing is winnable, and the player rests', () => {
    const state = fixtureGame(guarded, 0);
    const claimed = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, scriptedDice([])).state;
    const two = claimed.players[1]!;
    expect([...winnableBySkill(claimed, two)]).toEqual([]);

    for (const walks of ['counted', 'replayed'] as const) {
      const after = playRolloutTurn(rolloutCursor(claimed, player('one')), options({ targets: winnableBySkill, walks }));
      expect(after.state.players[1]?.position).toBe(two.position);
      expect(after.state.players[1]?.stats.stamina).toBe(two.stats.stamina + DEFAULT_GAME_CONFIG.movement.REST_STAMINA_GAIN);
      expect(after.state.turn.activeSeat).toBe(1);
      expect(after.targets).toEqual([null, null]);
    }
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

  it('rests when stuck, the designer’s rule (Q43): only when not one step can be paid', () => {
    expect(turnTowards(stuckGame(), n(5), restRule)).toEqual({ kind: 'rest', player: player('one') });
    const able = withStats(stuckGame(), player('one'), { stamina: 1 });
    expect(turnTowards(able, n(5), restRule).kind).toBe('move');
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

describe('turnCapTermination', () => {
  it('stops a simulated game SIMULATION_TURN_CAP turns after the position it started from (Q44)', () => {
    const cap = turnCapTermination(goldExhaustedTermination(), 7, DEFAULT_GAME_CONFIG.ai.SIMULATION_TURN_CAP);
    const at = (turn: number) => rolloutCursor({ ...fixtureGame(line, 0), turn: { ...fixtureGame(line, 0).turn, number: turn } }, player('one'));
    expect(cap.isTerminal(at(7), 0)).toBe(false);
    expect(cap.isTerminal(at(7 + 249), 0)).toBe(false);
    expect(cap.isTerminal(at(7 + 250), 0)).toBe(true);
  });

  it('still stops when the gold runs out first', () => {
    let state = withPosition(withPosition(fixtureGame(line, 0), player('one'), 5), player('two'), 5);
    state = withStats(state, player('one'), { stamina: 10 });
    const end = runRollout(rolloutCursor(state, player('one')), options({ termination: turnCapTermination(goldExhaustedTermination(), 1, 250) }));
    expect(unclaimedGoldUnits(end.state)).toBe(0);
  });
});

describe('counted walks in imagined games (Q210, stage 3, 823 A)', () => {
  /**
   *   0 ── 1 ── 2 ── 3 ── 4 ── 5 (gold 3)    plains all the way
   *   └─── 6f ── 7f ── 8f ──────┘            or through the forest
   * Gold 1 on 9, off 0, so taking 5 does not end the game.
   */
  const detour = fixtureMap({
    terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'forest', 'forest', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [0, 6],
      [6, 7],
      [7, 8],
      [8, 5],
      [0, 9],
    ],
    pois: [
      { node: 5, kind: 'gold', units: 3, guard: null },
      { node: 9, kind: 'gold', units: 1, guard: null },
    ],
  });
  const forester = () => withStats(stuckGame(detour), player('one'), { forest_move: 3, plains_move: 1 });

  it('walks the best route for the player’s speeds', () => {
    // Through the forest it is four free steps; along the plains it gets one.
    const cursor = { ...rolloutCursor(forester(), player('one')), targets: [n(5), null] };
    const counted = playRolloutTurn(cursor, options());
    expect(counted.state.players[0]?.position).toBe(n(5));
    expect(poiRuntimeAt(counted.state, n(5))?.claimedBy).toBe(player('one'));
    expect(counted.targets[0]).toBeNull();

    const replayed = playRolloutTurn(cursor, options({ walks: 'replayed' }));
    expect(replayed.state.players[0]?.position).toBe(n(1));
  });

  it('traces the route once and walks on along it', () => {
    let cursor = rolloutCursor(withStats(stuckGame(), player('one'), { plains_move: 1 }), player('one'));
    cursor = { ...cursor, targets: [n(6), null] };
    cursor = playRolloutTurn(cursor, options());
    const route = cursor.walks[0]?.route;
    expect(route).toEqual([n(1), n(2), n(3), n(4), n(5), n(6)]);
    expect(cursor.walks[0]?.walked).toBe(1);
    cursor = playRolloutTurn(playRolloutTurn(cursor, options()), options());
    expect(cursor.walks[0]?.route).toBe(route);
    expect(cursor.walks[0]?.walked).toBe(2);
    expect(cursor.state.players[0]?.position).toBe(n(2));
  });

  it('takes a site where a turn ends on the way, and keeps its target', () => {
    // Two free steps end the first turn on the stamina site at 2.
    let cursor = rolloutCursor(withStats(stuckGame(), player('one'), { plains_move: 2 }), player('one'));
    cursor = playRolloutTurn({ ...cursor, targets: [n(5), null] }, options());
    expect(cursor.state.players[0]?.position).toBe(n(2));
    expect(poiRuntimeAt(cursor.state, n(2))?.claimedBy).toBe(player('one'));
    // [Q240] Its one stamina unit gives STAMINA_PER_UNIT, 5.
    expect(cursor.state.players[0]?.stats.stamina).toBe(5);
    expect(cursor.targets[0]).toBe(n(5));
  });

  it('plays exactly the game the rules would along the same route', () => {
    // Counted along the cheapest route, an imagined game is the one walked
    // turn by turn through applyAction: every claim, roll, rest and win.
    const board = (state: GameState) => ({
      players: state.players.map((seat) => ({ position: seat.position, stats: seat.stats })),
      poiRuntime: state.poiRuntime,
      turn: state.turn,
      status: state.status,
      winners: state.winners,
    });
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const [map, start] of [
        [line, 3],
        [detour, 0],
      ] as const) {
        const play = (walks: 'counted' | 'replayed') =>
          runRollout(
            rolloutCursor(fixtureGame(map, start), player('one')),
            options({
              config: DEFAULT_GAME_CONFIG,
              rng: createRng(seed),
              dice: createDiceSource(createRng(seed), DEFAULT_GAME_CONFIG),
              walks,
              walkRoute: cheapestRoute,
            }),
          ).state;
        expect(board(play('counted'))).toEqual(board(play('replayed')));
      }
    }
  });
});

describe('closestWinnableBySpeeds (winnableBySkill and closestBySpeeds in one pass)', () => {
  /**
   * 0(p) ─ 1(f) ─ 2(p) ─ 3(m) ─ 4(p) ─ 5(f) ─ 6(p) ─ 7(p): a fighting skill
   * on 1; gold on 2 behind fighting 6 (won with fighting 1), on 3 behind
   * magic 9 (won with magic 4), on 6 behind fighting 5 (won by anyone) and
   * on 7 unguarded; a stamina site on 5.
   */
  const guards = fixtureMap({
    terrains: ['plains', 'forest', 'plains', 'mountain', 'plains', 'forest', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ],
    pois: [
      { node: 1, kind: 'fighting', units: 1, guard: null },
      { node: 2, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 6 } },
      { node: 3, kind: 'gold', units: 3, guard: { type: 'magic', strength: 9 } },
      { node: 5, kind: 'stamina', units: 2, guard: null },
      { node: 6, kind: 'gold', units: 1, guard: { type: 'fighting', strength: 5 } },
      { node: 7, kind: 'gold', units: 2, guard: null },
    ],
  });

  /** `claimed` sites of `guards` taken by seat two, seat one standing on `from` with the stats given. */
  function scene(from: number, stats: Partial<PlayerStats>, claimed: readonly number[] = []): { state: GameState; player: PlayerState } {
    let state = withStats(withPosition(fixtureGame(guards, 0), player('one'), from), player('one'), stats);
    state = { ...state, poiRuntime: state.poiRuntime.map((runtime, index) => (claimed.includes(index) ? { claimedBy: player('two'), claimedOnTurn: 1 } : runtime)) };
    return { state, player: state.players[0] as PlayerState };
  }

  it('finds the sites the two find, in their order, from every space and at every skill, with claims', () => {
    const rng = createRng('fused');
    const skills = [{}, { fighting: 1 }, { magic: 4 }, { fighting: 2, magic: 4 }];
    const claims: readonly (readonly number[])[] = [[], [0], [3, 5], [0, 3, 4, 5], [0, 1, 2, 3, 4, 5]];
    for (let from = 0; from < 8; from++) {
      for (const skill of skills) {
        for (const claimed of claims) {
          const speeds = { plains_move: rng.nextInt(3), forest_move: rng.nextInt(3), mountain_move: rng.nextInt(3) };
          const { state, player: seatOne } = scene(from, { ...skill, ...speeds }, claimed);
          for (const count of [1, 2, 6, 10]) {
            expect(closestWinnableBySpeeds(state, seatOne, count)).toEqual(closestBySpeeds(state, seatOne, winnableBySkill(state, seatOne), count));
          }
        }
      }
    }
  });

  it('counts guarded gold winnable by the skill alone, on the best roll', () => {
    // From 4 with no speed: 5 is 5 + 2 = 7 away, 6 is 8, 7 is 9 and 1 is 11;
    // 2 is 9 at cost 4 like 7, and 3 is 8 at cost 3 like 6, so each goes first.
    const nobody = scene(4, {});
    expect(closestWinnableBySpeeds(nobody.state, nobody.player, 10).map((candidate) => candidate.node)).toEqual([n(5), n(6), n(7), n(1)]);
    const fighter = scene(4, { fighting: 1 });
    expect(closestWinnableBySpeeds(fighter.state, fighter.player, 10).map((candidate) => candidate.node)).toEqual([n(5), n(6), n(2), n(7), n(1)]);
    const mage = scene(4, { magic: 4 });
    expect(closestWinnableBySpeeds(mage.state, mage.player, 10).map((candidate) => candidate.node)).toEqual([n(5), n(3), n(6), n(7), n(1)]);
    expect(closestWinnableBySpeeds(mage.state, mage.player, 2).map((candidate) => candidate.node)).toEqual([n(5), n(3)]);
  });

  it('finds nothing where nothing is winnable, and the player rests', () => {
    const { state, player: seatOne } = scene(4, {}, [0, 3, 4, 5]);
    expect(closestWinnableBySpeeds(state, seatOne, 10)).toEqual([]);
    expect([...winnableBySkill(state, seatOne)]).toEqual([]);
    const after = playRolloutTurn(rolloutCursor(state, player('one')), options({ candidates: closestWinnableBySpeeds }));
    expect(after.state.players[0]?.position).toBe(n(4));
    expect(after.state.players[0]?.stats.stamina).toBe(seatOne.stats.stamina + DEFAULT_GAME_CONFIG.movement.REST_STAMINA_GAIN);
    expect(after.targets).toEqual([null, null]);
  });

  it('plays the very games that targets and closest apart play', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const play = (overrides: Partial<RolloutOptions>) =>
        runRollout(
          rolloutCursor(fixtureGame(guards, 0), player('one')),
          options({
            config: DEFAULT_GAME_CONFIG,
            termination: turnCapTermination(goldExhaustedTermination(), 1, 60),
            rng: createRng(seed),
            dice: createDiceSource(createRng(seed), DEFAULT_GAME_CONFIG),
            ...overrides,
          }),
        );
      const apart = play({ targets: winnableBySkill, closest: closestBySpeeds });
      const fused = play({ candidates: closestWinnableBySpeeds });
      expect(fused.state).toEqual(apart.state);
      expect(fused.targets).toEqual(apart.targets);
      expect(apart.state.turn.number).toBeGreaterThan(5);
    }
  });
});

describe('goldExhaustedTermination', () => {
  it('reads each state it is asked about, however many times and whichever game', () => {
    const termination = goldExhaustedTermination();
    const start = fixtureGame(line, 4);
    const claimed = (state: GameState, indices: readonly number[]): GameState => ({
      ...state,
      poiRuntime: state.poiRuntime.map((runtime, index) => (indices.includes(index) ? { claimedBy: player('one'), claimedOnTurn: 1 } : runtime)),
    });
    const oneLeft = claimed(start, [2]);
    const none = claimed(start, [2, 3]);
    expect(termination.isTerminal(rolloutCursor(start, player('one')), 0)).toBe(false);
    expect(termination.isTerminal(rolloutCursor(start, player('one')), 0)).toBe(false);
    expect(termination.isTerminal(rolloutCursor(oneLeft, player('one')), 0)).toBe(false);
    expect(termination.isTerminal(rolloutCursor(none, player('one')), 0)).toBe(true);
    expect(termination.isTerminal(rolloutCursor(oneLeft, player('one')), 0)).toBe(false);
    expect(termination.isTerminal(rolloutCursor(none, player('one')), 0)).toBe(true);
    expect(termination.isTerminal(rolloutCursor({ ...start, status: 'finished' }, player('one')), 0)).toBe(true);
    expect(termination.isTerminal(rolloutCursor(start, player('one')), 0)).toBe(false);
  });
});
