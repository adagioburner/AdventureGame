import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { asGameId, asUserId, startingNodeFor, type UserId } from '@adventure/core';
import type { SetupState } from '@adventure/protocol';
import { fixtureMap } from '../../core/src/rules/scenario.fixture.ts';
import { applySetupAction, createSetup, SetupError, setupLimitsFor, startGame, type SetupAction } from './setup.ts';

const FIGURES = ['fig_01', 'fig_02', 'fig_03', 'fig_04', 'fig_05', 'fig_06'];
const limits = setupLimitsFor(DEFAULT_RULESET, FIGURES);
const G = asGameId('g1');
const andrei = asUserId('andrei');
const bea = asUserId('bea');
const cal = asUserId('cal');

function fresh(): SetupState {
  return createSetup(
    { gameId: G, name: 'Andrei’s game', gameMaster: { userId: andrei, displayName: 'Andrei' }, createdAt: 1, mapSeed: 'fixture' },
    limits,
  );
}

/** Applies each step in turn, as the session would. */
function play(state: SetupState, ...steps: [UserId, SetupAction][]): SetupState {
  return steps.reduce((current, [by, action]) => applySetupAction(current, by, action, limits, 100).state, state);
}

const act = {
  count: (count: number): SetupAction => ({ type: 'setup.setPlayerCount', gameId: G, count }),
  ask: (name: string, avatarId: string): SetupAction => ({ type: 'setup.requestJoin', gameId: G, name, avatarId }),
  change: (name: string, avatarId: string): SetupAction => ({ type: 'setup.updateRequest', gameId: G, name, avatarId }),
  accept: (userId: UserId): SetupAction => ({ type: 'setup.respondToJoin', gameId: G, userId, accept: true }),
  decline: (userId: UserId): SetupAction => ({ type: 'setup.respondToJoin', gameId: G, userId, accept: false }),
  seat: (seatId: string, name: string, avatarId: string): SetupAction => ({ type: 'setup.updateSeat', gameId: G, seatId, name, avatarId }),
  leave: (): SetupAction => ({ type: 'setup.leave', gameId: G }),
  withdraw: (): SetupAction => ({ type: 'setup.withdraw', gameId: G }),
  start: (): SetupAction => ({ type: 'setup.start', gameId: G }),
};

function refused(state: SetupState, by: UserId, action: SetupAction): SetupError {
  try {
    applySetupAction(state, by, action, limits, 100);
  } catch (error) {
    if (error instanceof SetupError) return error;
    throw error;
  }
  throw new Error(`expected ${action.type} to be refused`);
}

const seatsOf = (state: SetupState) => state.seats.map((seat) => [seat.seat, seat.name, seat.avatarId, seat.control]);

describe('a new game', () => {
  it('puts its creator in seat 1 and a computer in the other seat of two', () => {
    const state = fresh();
    expect(state.phase).toBe('setup');
    expect(state.playerCount).toBe(2);
    expect(state.thinkingSeconds).toBe(10);
    expect(state.gameMasterName).toBe('Andrei');
    expect(seatsOf(state)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Computer 1', 'fig_02', 'ai'],
    ]);
  });

  it('needs a name', () => {
    expect(() =>
      createSetup({ gameId: G, name: '  ', gameMaster: { userId: andrei, displayName: 'A' }, createdAt: 1, mapSeed: 's' }, limits),
    ).toThrow(SetupError);
  });
});

describe('the player count', () => {
  it('adds and removes computers, numbering new ones after the rest', () => {
    const three = play(fresh(), [andrei, act.count(3)]);
    expect(seatsOf(three)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Computer 1', 'fig_02', 'ai'],
      [3, 'Computer 2', 'fig_03', 'ai'],
    ]);
    expect(seatsOf(play(three, [andrei, act.count(2)]))).toEqual(seatsOf(fresh()));
  });

  it('is the game master’s, within 2 to 5, and never below the seats people hold', () => {
    expect(refused(fresh(), bea, act.count(3)).code).toBe('not_game_master');
    expect(refused(fresh(), andrei, act.count(1)).code).toBe('invalid_action');
    expect(refused(fresh(), andrei, act.count(6)).code).toBe('invalid_action');
    expect(refused(fresh(), andrei, act.count(2.5)).code).toBe('invalid_action');
    const three = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    const full = play(three, [cal, act.ask('Cal', 'fig_05')], [andrei, act.accept(cal)]);
    expect(refused(full, andrei, act.count(2)).message).toMatch(/3 seats are already taken/);
  });
});

describe('joining', () => {
  it('takes the next seat in the order the game master accepts, and a computer gives it up', () => {
    const state = play(
      fresh(),
      [andrei, act.count(4)],
      [bea, act.ask('Bea', 'fig_05')],
      [cal, act.ask('Cal', 'fig_06')],
      [andrei, act.accept(cal)],
      [andrei, act.accept(bea)],
    );
    expect(seatsOf(state)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Cal', 'fig_06', 'human'],
      [3, 'Bea', 'fig_05', 'human'],
      [4, 'Computer 1', 'fig_02', 'ai'],
    ]);
    expect(state.pending).toEqual([]);
  });

  it('keeps one request per person, which they can change or withdraw', () => {
    const asked = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [bea, act.ask('Beatrice', 'fig_05')]);
    expect(asked.pending).toEqual([{ userId: bea, requestedName: 'Beatrice', requestedAvatarId: 'fig_05', requestedAt: 100 }]);
    expect(play(asked, [bea, act.withdraw()]).pending).toEqual([]);
    expect(refused(fresh(), bea, act.withdraw()).code).toBe('invalid_action');
  });

  it('refuses a figure another person in the game holds, a name that is empty or too long, and a figure that does not exist', () => {
    expect(refused(fresh(), bea, act.ask('Bea', 'fig_01')).message).toMatch(/holds that figure/);
    expect(refused(fresh(), bea, act.ask('   ', 'fig_04')).code).toBe('invalid_action');
    expect(refused(fresh(), bea, act.ask('x'.repeat(25), 'fig_04')).code).toBe('invalid_action');
    expect(refused(fresh(), bea, act.ask('Bea', 'nope')).code).toBe('invalid_action');
  });

  it('tells a declined person so, and lets them ask again', () => {
    const asked = play(fresh(), [bea, act.ask('Bea', 'fig_04')]);
    const outcome = applySetupAction(asked, andrei, act.decline(bea), limits, 100);
    expect(outcome.declined).toBe(bea);
    expect(outcome.state.pending).toEqual([]);
    expect(play(outcome.state, [bea, act.ask('Bea', 'fig_04')]).pending).toHaveLength(1);
  });

  it('refuses to accept when people hold every seat', () => {
    const full = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)], [cal, act.ask('Cal', 'fig_05')]);
    expect(refused(full, andrei, act.accept(cal)).code).toBe('game_full');
  });

  it('is the game master’s to accept or decline, and a seated person cannot ask again', () => {
    const asked = play(fresh(), [bea, act.ask('Bea', 'fig_04')]);
    expect(refused(asked, bea, act.accept(bea)).code).toBe('not_game_master');
    expect(refused(asked, andrei, act.accept(cal)).code).toBe('invalid_action');
    expect(refused(fresh(), andrei, act.ask('Andrei', 'fig_03')).code).toBe('invalid_action');
  });
});

describe('leaving', () => {
  it('gives the seat back to a computer and moves later people up', () => {
    const state = play(
      fresh(),
      [andrei, act.count(3)],
      [bea, act.ask('Bea', 'fig_04')],
      [andrei, act.accept(bea)],
      [cal, act.ask('Cal', 'fig_05')],
      [andrei, act.accept(cal)],
      [bea, act.leave()],
    );
    expect(seatsOf(state)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Cal', 'fig_05', 'human'],
      [3, 'Computer 1', 'fig_02', 'ai'],
    ]);
  });

  it('is not for the game master, who cancels instead, nor for someone without a seat', () => {
    expect(refused(fresh(), andrei, act.leave()).message).toMatch(/cancel/);
    expect(refused(fresh(), bea, act.leave()).code).toBe('invalid_action');
  });
});

describe('changing a seat', () => {
  it('lets a person change their own name and figure, and the game master a computer’s', () => {
    const joined = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    const state = play(
      joined,
      [bea, act.seat('person:bea', 'B', 'fig_06')],
      [andrei, act.seat('computer:1', 'Robo', 'fig_05')],
      [andrei, act.seat('person:andrei', 'Andy', 'fig_01')],
    );
    expect(seatsOf(state)).toEqual([
      [1, 'Andy', 'fig_01', 'human'],
      [2, 'B', 'fig_06', 'human'],
      [3, 'Robo', 'fig_05', 'ai'],
    ]);
  });

  it('refuses someone else’s seat, and a computer’s to anyone but the game master', () => {
    const joined = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(refused(joined, bea, act.seat('person:andrei', 'Bea', 'fig_04')).code).toBe('invalid_action');
    expect(refused(joined, andrei, act.seat('person:bea', 'Bea', 'fig_04')).code).toBe('invalid_action');
    expect(refused(joined, bea, act.seat('computer:1', 'Robo', 'fig_05')).code).toBe('not_game_master');
    expect(refused(joined, andrei, act.seat('computer:9', 'Nobody', 'fig_05')).code).toBe('invalid_action');
  });

  it('keeps a renamed computer’s name and figure as seats come and go', () => {
    const renamed = play(fresh(), [andrei, act.count(3)], [andrei, act.seat('computer:1', 'Robo', 'fig_06')]);
    const joined = play(renamed, [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(seatsOf(joined)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Bea', 'fig_04', 'human'],
      [3, 'Robo', 'fig_06', 'ai'],
    ]);
  });
});

describe('figures (Q49: details 18 and 19)', () => {
  it('gives a person the figure a computer holds, and the computer switches to a free one', () => {
    const three = play(fresh(), [andrei, act.count(3)]);
    const joined = play(three, [bea, act.ask('Bea', 'fig_02')], [andrei, act.accept(bea)]);
    expect(seatsOf(joined)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Bea', 'fig_02', 'human'],
      [3, 'Computer 1', 'fig_03', 'ai'],
    ]);
    const switched = play(joined, [andrei, act.seat('person:andrei', 'Andrei', 'fig_03')]);
    expect(seatsOf(switched)).toEqual([
      [1, 'Andrei', 'fig_03', 'human'],
      [2, 'Bea', 'fig_02', 'human'],
      [3, 'Computer 1', 'fig_01', 'ai'],
    ]);
  });

  it('does not let the game master give a computer a figure another seat holds, and says who holds it', () => {
    const three = play(fresh(), [andrei, act.count(3)]);
    expect(refused(three, andrei, act.seat('computer:1', 'Computer 1', 'fig_03')).message).toBe(
      'Computer 2 holds that figure now; pick another',
    );
    expect(refused(three, andrei, act.seat('computer:1', 'Computer 1', 'fig_01')).message).toMatch(/^Andrei holds/);
  });

  it('refuses a person a figure another person took a moment ago, naming them', () => {
    const joined = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(refused(joined, andrei, act.seat('person:andrei', 'Andrei', 'fig_04')).message).toBe('Bea holds that figure now; pick another');
    expect(refused(joined, cal, act.ask('Cal', 'fig_04')).message).toBe('Bea holds that figure now; pick another');
  });

  it('lets two requests name one figure; the first accepted gets it, and the other must pick again before being accepted', () => {
    const asked = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')], [cal, act.ask('Cal', 'fig_04')]);
    expect(asked.pending.map((request) => request.requestedAvatarId)).toEqual(['fig_04', 'fig_04']);
    const beaIn = play(asked, [andrei, act.accept(bea)]);
    const clash = refused(beaIn, andrei, act.accept(cal));
    expect(clash.message).toBe('Bea has taken the figure Cal asked for; Cal has to pick another before you can accept them');
    // Cal's request waits, and Cal can still change it.
    expect(beaIn.pending.map((request) => [request.requestedName, request.requestedAvatarId])).toEqual([['Cal', 'fig_04']]);
    expect(refused(beaIn, cal, act.change('Cal', 'fig_04')).message).toMatch(/^Bea holds/);
    const calIn = play(beaIn, [cal, act.change('Cal', 'fig_05')], [andrei, act.accept(cal)]);
    expect(seatsOf(calIn)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Bea', 'fig_04', 'human'],
      [3, 'Cal', 'fig_05', 'human'],
    ]);
  });

  it('lets a seated person take a figure a request names, which then has to be picked again', () => {
    const asked = play(fresh(), [andrei, act.count(3)], [bea, act.ask('Bea', 'fig_04')]);
    const taken = play(asked, [andrei, act.seat('person:andrei', 'Andrei', 'fig_04')]);
    expect(refused(taken, andrei, act.accept(bea)).message).toMatch(/^Andrei has taken the figure Bea asked for/);
  });
});

describe('changes that cross another (Q49)', () => {
  it('does not turn an edit that crosses a “no” into a new request', () => {
    const asked = play(fresh(), [bea, act.ask('Bea', 'fig_04')]);
    const declined = play(asked, [andrei, act.decline(bea)]);
    expect(refused(declined, bea, act.change('Bea', 'fig_05')).message).toBe('the game master has already answered your request');
    expect(declined.pending).toEqual([]);
  });

  it('points an edit that crosses a “yes” to the new seat', () => {
    const accepted = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(refused(accepted, bea, act.change('Bea', 'fig_05')).message).toMatch(/just accepted you/);
  });

  it('refuses a change aimed at a computer that has made way for a person, rather than changing the computer now in its seat', () => {
    const four = play(fresh(), [andrei, act.count(4)]);
    expect(four.seats.map((seat) => seat.id)).toEqual(['person:andrei', 'computer:1', 'computer:2', 'computer:3']);
    const joined = play(four, [bea, act.ask('Bea', 'fig_05')], [andrei, act.accept(bea)]);
    expect(joined.seats.map((seat) => seat.id)).toEqual(['person:andrei', 'person:bea', 'computer:1', 'computer:2']);
    expect(refused(joined, andrei, act.seat('computer:3', 'Robo', 'fig_06')).message).toMatch(/made way for a person/);
  });

  it('never gives a new computer the id of one that went', () => {
    const state = play(fresh(), [andrei, act.count(3)], [andrei, act.count(2)], [andrei, act.count(3)]);
    expect(state.seats.map((seat) => [seat.id, seat.name])).toEqual([
      ['person:andrei', 'Andrei'],
      ['computer:1', 'Computer 1'],
      ['computer:3', 'Computer 2'],
    ]);
  });
});

describe('the game master’s other settings', () => {
  it('sets the map seed and the computers’ thinking time, whole seconds from 1 to 60', () => {
    const state = play(
      fresh(),
      [andrei, { type: 'setup.setSeed', gameId: G, seed: ' amber-birch-3 ' }],
      [andrei, { type: 'setup.setThinkingTime', gameId: G, seconds: 25 }],
    );
    expect(state.mapSeed).toBe('amber-birch-3');
    expect(state.thinkingSeconds).toBe(25);
    for (const seconds of [0, 61, 2.5]) {
      expect(refused(fresh(), andrei, { type: 'setup.setThinkingTime', gameId: G, seconds }).code).toBe('invalid_action');
    }
    expect(refused(fresh(), bea, { type: 'setup.setSeed', gameId: G, seed: 'x' }).code).toBe('not_game_master');
  });

  it('cancels, after which nothing more happens in setup', () => {
    const cancelled = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [andrei, { type: 'setup.cancel', gameId: G }]);
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.pending).toEqual([]);
    expect(refused(cancelled, bea, act.ask('Bea', 'fig_04')).code).toBe('invalid_action');
  });
});

describe('starting', () => {
  // Two plains nodes that hold no POI, so there is somewhere to start.
  const map = fixtureMap({
    terrains: ['plains', 'plains', 'forest', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    pois: [{ node: 3, kind: 'gold', units: 2, guard: null }],
  });

  it('may happen with seats empty, even with nobody else joined, and computers play them', () => {
    const starting = play(fresh(), [andrei, act.count(3)], [andrei, act.start()]);
    expect(starting.phase).toBe('starting');
    const { setup, game } = startGame(starting, map);
    expect(setup.phase).toBe('started');
    expect(game.players.map((player) => [player.seat, player.name, player.control])).toEqual([
      [1, 'Andrei', 'human'],
      [2, 'Computer 1', 'ai'],
      [3, 'Computer 2', 'ai'],
    ]);
    // §6: later seats start with more stamina, so the computers have the most.
    expect(game.players.map((player) => player.stats.stamina)).toEqual([30, 40, 50]);
    expect(new Set(game.players.map((player) => player.position))).toEqual(new Set([startingNodeFor(map)]));
  });

  it('is the game master’s, and needs the map for the setup’s own seed', () => {
    expect(refused(fresh(), bea, act.start()).code).toBe('not_game_master');
    const starting = play(fresh(), [andrei, act.start()]);
    expect(() => startGame(starting, { ...map, seed: 'another' })).toThrow(/another seed/);
    expect(() => startGame(fresh(), map)).toThrow(/not starting/);
    expect(refused(starting, andrei, act.count(3)).code).toBe('invalid_action');
  });
});
