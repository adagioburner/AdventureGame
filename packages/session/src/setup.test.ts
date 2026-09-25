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
  control: (seatId: string, control: 'human' | 'ai'): SetupAction => ({ type: 'setup.setSeatControl', gameId: G, seatId, control }),
  think: (seatId: string, seconds: number): SetupAction => ({ type: 'setup.setThinkingTime', gameId: G, seatId, seconds }),
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
const idsOf = (state: SetupState) => state.seats.map((seat) => seat.id);

/** An open Human seat, as `seatsOf` shows it. */
const open = (seat: number) => [seat, '', '', 'human'];

/** A game of `count` whose seats after the game master's are all computers. */
function withComputers(count: number): SetupState {
  let state = play(fresh(), [andrei, act.count(count)]);
  for (const seat of state.seats.slice(1)) state = play(state, [andrei, act.control(seat.id, 'ai')]);
  return state;
}

describe('a new game', () => {
  it('puts its creator in seat 1 and keeps seat 2 Human, as a new hot seat game has two Human seats (Q51)', () => {
    const state = fresh();
    expect(state.phase).toBe('setup');
    expect(state.playerCount).toBe(2);
    expect(state.gameMasterName).toBe('Andrei');
    expect(seatsOf(state)).toEqual([[1, 'Andrei', 'fig_01', 'human'], open(2)]);
    expect(idsOf(state)).toEqual(['person:andrei', 'open:1']);
  });

  it('can be made from the setup a page already had: its computers stay, its other Human seats open (Q51, 25)', () => {
    const state = createSetup(
      {
        gameId: G,
        name: 'Andrei’s game',
        gameMaster: { userId: andrei, displayName: 'Andrei' },
        createdAt: 1,
        mapSeed: 'fixture',
        seats: [
          { control: 'human', avatarId: 'fig_03' },
          { control: 'ai', name: 'Robo', avatarId: 'fig_01', thinkingSeconds: 25 },
          { control: 'human' },
        ],
      },
      limits,
    );
    expect(seatsOf(state)).toEqual([[1, 'Andrei', 'fig_03', 'human'], [2, 'Robo', 'fig_01', 'ai'], open(3)]);
    expect(state.seats[1]?.thinkingSeconds).toBe(25);
    expect(state.playerCount).toBe(3);
  });

  it('needs a name, 2 to 5 seats, and computers with figures of their own and a thinking time in range', () => {
    const make = (extra: object) =>
      createSetup({ gameId: G, name: 'g', gameMaster: { userId: andrei, displayName: 'A' }, createdAt: 1, mapSeed: 's', ...extra }, limits);
    expect(() => make({ name: '  ' })).toThrow(SetupError);
    expect(() => make({ seats: [{ control: 'human' }] })).toThrow(/2 to 5 players/);
    expect(() => make({ seats: Array.from({ length: 6 }, () => ({ control: 'human' })) })).toThrow(/2 to 5 players/);
    expect(() =>
      make({ seats: [{ control: 'human', avatarId: 'fig_02' }, { control: 'ai', name: 'R', avatarId: 'fig_02', thinkingSeconds: 10 }] }),
    ).toThrow(/A holds that figure/);
    expect(() =>
      make({ seats: [{ control: 'human' }, { control: 'ai', name: 'R', avatarId: 'fig_02', thinkingSeconds: 61 }] }),
    ).toThrow(/1 to 60/);
  });
});

describe('the player count', () => {
  it('adds Human seats, and removes the last seats nobody holds', () => {
    const four = play(fresh(), [andrei, act.count(4)]);
    expect(seatsOf(four)).toEqual([[1, 'Andrei', 'fig_01', 'human'], open(2), open(3), open(4)]);
    const mixed = play(four, [andrei, act.control('open:2', 'ai')], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(seatsOf(mixed)).toEqual([[1, 'Andrei', 'fig_01', 'human'], [2, 'Bea', 'fig_04', 'human'], [3, 'Computer 1', 'fig_02', 'ai'], open(4)]);
    expect(seatsOf(play(mixed, [andrei, act.count(2)]))).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Bea', 'fig_04', 'human'],
    ]);
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

describe('Human and Computer seats (Q51, 22)', () => {
  it('turns a Human seat nobody holds into a new computer, and back', () => {
    const computer = play(fresh(), [andrei, act.control('open:1', 'ai')]);
    expect(seatsOf(computer)).toEqual([[1, 'Andrei', 'fig_01', 'human'], [2, 'Computer 1', 'fig_02', 'ai']]);
    expect(computer.seats[1]?.thinkingSeconds).toBe(10);
    const human = play(computer, [andrei, act.control('computer:2', 'human')]);
    expect(seatsOf(human)).toEqual([[1, 'Andrei', 'fig_01', 'human'], open(2)]);
    expect(idsOf(human)).toEqual(['person:andrei', 'open:3']);
  });

  it('is the game master’s, and not for their own seat or a seat a person holds', () => {
    expect(refused(fresh(), bea, act.control('open:1', 'ai')).code).toBe('not_game_master');
    expect(refused(fresh(), andrei, act.control('person:andrei', 'ai')).message).toBe('your own seat is always Human');
    const joined = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(refused(joined, andrei, act.control('person:bea', 'ai')).message).toBe('Bea holds that seat; only they can leave it');
  });

  it('changes nothing when the seat already is what was asked', () => {
    expect(play(fresh(), [andrei, act.control('open:1', 'human')])).toEqual(fresh());
  });
});

describe('joining', () => {
  it('takes the first Human seat nobody holds, in the order the game master accepts', () => {
    const state = play(
      fresh(),
      [andrei, act.count(4)],
      [andrei, act.control('open:2', 'ai')],
      [bea, act.ask('Bea', 'fig_05')],
      [cal, act.ask('Cal', 'fig_06')],
      [andrei, act.accept(cal)],
      [andrei, act.accept(bea)],
    );
    expect(seatsOf(state)).toEqual([
      [1, 'Andrei', 'fig_01', 'human'],
      [2, 'Cal', 'fig_06', 'human'],
      [3, 'Computer 1', 'fig_02', 'ai'],
      [4, 'Bea', 'fig_05', 'human'],
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

  it('refuses to accept while no Human seat is free, people or computers holding them all', () => {
    const full = play(fresh(), [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)], [cal, act.ask('Cal', 'fig_05')]);
    expect(refused(full, andrei, act.accept(cal)).code).toBe('game_full');
    const computers = play(withComputers(2), [cal, act.ask('Cal', 'fig_05')]);
    expect(refused(computers, andrei, act.accept(cal)).message).toMatch(/make a seat Human or raise the number of players/);
  });

  it('is the game master’s to accept or decline, and a seated person cannot ask again', () => {
    const asked = play(fresh(), [bea, act.ask('Bea', 'fig_04')]);
    expect(refused(asked, bea, act.accept(bea)).code).toBe('not_game_master');
    expect(refused(asked, andrei, act.accept(cal)).code).toBe('invalid_action');
    expect(refused(fresh(), andrei, act.ask('Andrei', 'fig_03')).code).toBe('invalid_action');
  });
});

describe('leaving', () => {
  it('opens the seat again for someone else, and nobody moves', () => {
    const state = play(
      fresh(),
      [andrei, act.count(3)],
      [bea, act.ask('Bea', 'fig_04')],
      [andrei, act.accept(bea)],
      [cal, act.ask('Cal', 'fig_05')],
      [andrei, act.accept(cal)],
      [bea, act.leave()],
    );
    expect(seatsOf(state)).toEqual([[1, 'Andrei', 'fig_01', 'human'], open(2), [3, 'Cal', 'fig_05', 'human']]);
  });

  it('is not for the game master, who cancels instead, nor for someone without a seat', () => {
    expect(refused(fresh(), andrei, act.leave()).message).toMatch(/cancel/);
    expect(refused(fresh(), bea, act.leave()).code).toBe('invalid_action');
  });
});

describe('changing a seat', () => {
  it('lets a person change their own name and figure, and the game master a computer’s', () => {
    const joined = play(fresh(), [andrei, act.count(3)], [andrei, act.control('open:2', 'ai')], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    const state = play(
      joined,
      [bea, act.seat('person:bea', 'B', 'fig_06')],
      [andrei, act.seat('computer:3', 'Robo', 'fig_05')],
      [andrei, act.seat('person:andrei', 'Andy', 'fig_01')],
    );
    expect(seatsOf(state)).toEqual([
      [1, 'Andy', 'fig_01', 'human'],
      [2, 'B', 'fig_06', 'human'],
      [3, 'Robo', 'fig_05', 'ai'],
    ]);
  });

  it('refuses someone else’s seat, a computer’s to anyone but the game master, and a seat nobody holds', () => {
    const joined = play(fresh(), [andrei, act.count(3)], [andrei, act.control('open:2', 'ai')], [bea, act.ask('Bea', 'fig_04')], [andrei, act.accept(bea)]);
    expect(refused(joined, bea, act.seat('person:andrei', 'Bea', 'fig_04')).code).toBe('invalid_action');
    expect(refused(joined, andrei, act.seat('person:bea', 'Bea', 'fig_04')).code).toBe('invalid_action');
    expect(refused(joined, bea, act.seat('computer:3', 'Robo', 'fig_05')).code).toBe('not_game_master');
    expect(refused(joined, andrei, act.seat('computer:9', 'Nobody', 'fig_05')).code).toBe('invalid_action');
    expect(refused(fresh(), andrei, act.seat('open:1', 'Nobody', 'fig_05')).message).toBe('nobody holds that seat yet');
  });

  it('gives each computer its own thinking time, whole seconds from 1 to 60 (Q51, 24)', () => {
    const three = withComputers(3);
    const state = play(three, [andrei, act.think('computer:3', 25)]);
    expect(state.seats.map((seat) => [seat.id, seat.thinkingSeconds])).toEqual([
      ['person:andrei', 10],
      ['computer:3', 25],
      ['computer:4', 10],
    ]);
    for (const seconds of [0, 61, 2.5]) expect(refused(three, andrei, act.think('computer:3', seconds)).code).toBe('invalid_action');
    expect(refused(three, bea, act.think('computer:3', 20)).code).toBe('not_game_master');
    expect(refused(fresh(), andrei, act.think('open:1', 20)).message).toBe('only a computer seat has a thinking time');
  });
});

describe('figures (Q49: details 18 and 19)', () => {
  it('gives a person the figure a computer holds, and the computer switches to a free one', () => {
    const three = play(fresh(), [andrei, act.count(3)], [andrei, act.control('open:2', 'ai')]);
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
    const three = withComputers(3);
    expect(refused(three, andrei, act.seat('computer:3', 'Computer 1', 'fig_03')).message).toBe(
      'Computer 2 holds that figure now; pick another',
    );
    expect(refused(three, andrei, act.seat('computer:3', 'Computer 1', 'fig_01')).message).toMatch(/^Andrei holds/);
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

  it('refuses a change aimed at a seat that has just changed, rather than changing whatever holds it now', () => {
    const computer = play(fresh(), [andrei, act.control('open:1', 'ai')]);
    const human = play(computer, [andrei, act.control('computer:2', 'human')]);
    expect(refused(human, andrei, act.seat('computer:2', 'Robo', 'fig_06')).message).toBe('that seat has just changed; look again');
    expect(refused(human, andrei, act.control('computer:2', 'human')).message).toBe('that seat has just changed; look again');
    const joined = play(fresh(), [bea, act.ask('Bea', 'fig_05')], [andrei, act.accept(bea)]);
    expect(refused(joined, andrei, act.control('open:1', 'ai')).message).toBe('that seat has just changed; look again');
  });

  it('never gives a seat the id of one that went', () => {
    const state = play(fresh(), [andrei, act.count(3)], [andrei, act.count(2)], [andrei, act.count(3)]);
    expect(idsOf(state)).toEqual(['person:andrei', 'open:1', 'open:3']);
  });
});

describe('the game master’s other settings', () => {
  it('sets the map seed and the game’s name', () => {
    const state = play(
      fresh(),
      [andrei, { type: 'setup.setSeed', gameId: G, seed: ' amber-birch-3 ' }],
      [andrei, { type: 'setup.rename', gameId: G, name: ' Friday game ' }],
    );
    expect(state.mapSeed).toBe('amber-birch-3');
    expect(state.name).toBe('Friday game');
    expect(refused(fresh(), bea, { type: 'setup.setSeed', gameId: G, seed: 'x' }).code).toBe('not_game_master');
    expect(refused(fresh(), bea, { type: 'setup.rename', gameId: G, name: 'x' }).code).toBe('not_game_master');
    expect(refused(fresh(), andrei, { type: 'setup.rename', gameId: G, name: 'x'.repeat(41) }).code).toBe('invalid_action');
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
    expect(idsOf(starting)).toEqual(['person:andrei', 'computer:3', 'computer:4']);
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
