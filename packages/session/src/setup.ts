import type { IntRange, Ruleset } from '@adventure/config';
import {
  asPlayerId,
  type GameId,
  type GameMap,
  type GameState,
  type UserId,
} from '@adventure/core';
import {
  DAY_MS,
  DEFAULT_LIFETIME_DAYS,
  isOpenSeat,
  LIFETIME_DAYS,
  openingStateOf,
  type ClientMessage,
  type JoinRequest,
  type NewGameSeat,
  type ProtocolErrorCode,
  type SetupSeat,
  type SetupState,
} from '@adventure/protocol';

/**
 * [SOURCE §3] §6.1's setup flow, as pure functions over `SetupState`: the GM
 * chooses the player count, users ask to join, the GM accepts or declines,
 * each player picks a name and figure, and the GM starts. `GameSession` runs
 * these one message at a time and does the storing and sending.
 *
 * [Q48] Andrei's answers settle the details: the GM plays, always in seat 1,
 * and may start with seats empty, alone if they like; a computer plays each
 * empty seat. Computer seats are "Computer 1", "Computer 2" and so on, each
 * with a free figure, and the GM may rename them and change their figures
 * before the start.
 *
 * [Q51] One setup screen for hot seat and online games, Andrei's answers to
 * phase 6 details 21 to 30. Every seat but the GM's is Human or Computer, as
 * the GM sets it (22). A Human seat nobody holds is open: accepting someone
 * puts them in the first open seat, and an open seat still empty at Start is
 * played by the computer. Each computer seat has its own thinking time (24).
 * A new game has two seats, both Human, as on the hot seat screen, unless it
 * was made from a setup the page already had (25).
 *
 * [Q49] Figures, Andrei's answers to phase 6 details 18 and 19: a person
 * may take a figure a computer holds, and the computer switches to a free
 * one; a join request holds no figure, so two may name the same one, and the
 * first accepted gets it while the other waits for its sender to pick again.
 * He added that whichever way a clash resolves matters less than that it is
 * detected, resolved and told to the people it affects, so every refusal
 * below names who holds the figure, and a request whose figure was taken
 * shows as such to its sender and to the game master (the panel reads it off
 * the state).
 *
 * [SOURCE §2, chat] Starting stamina is then `startingStaminaForSeat(seat)`
 * from `@adventure/config`, inside `createGameState`.
 */

/** What a setup is checked against, fixed for a game when it is created. */
export interface SetupLimits {
  /** §11 `PLAYER_COUNT`. */
  readonly playerCount: IntRange;
  /** §11's thinking-time range for a computer seat, whole seconds (Q41). */
  readonly thinkingSeconds: IntRange;
  readonly defaultThinkingSeconds: number;
  /** The figure ids on the figurine sheet, in the sheet's order. */
  readonly figures: readonly string[];
  /** A player's name, as on the hot seat panel. */
  readonly nameMaxLength: number;
  readonly gameNameMaxLength: number;
  readonly seedMaxLength: number;
}

export function setupLimitsFor(ruleset: Ruleset, figures: readonly string[]): SetupLimits {
  return {
    playerCount: ruleset.config.players.PLAYER_COUNT,
    thinkingSeconds: ruleset.config.ai.THINKING_TIME_SECONDS,
    defaultThinkingSeconds: Math.round(ruleset.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1000),
    figures,
    nameMaxLength: 24,
    gameNameMaxLength: 40,
    seedMaxLength: 64,
  };
}

/** A setup action that was refused, with the protocol's code for it. */
export class SetupError extends Error {
  override readonly name = 'SetupError';
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NewSetup {
  readonly gameId: GameId;
  readonly name: string;
  readonly gameMaster: { readonly userId: UserId; readonly displayName: string };
  readonly createdAt: number;
  readonly mapSeed: string;
  /**
   * [Q51, 25] The seats a page already had when "Play online" was turned on,
   * seat 1 the game master's. Without them the game starts with two seats,
   * both Human, as a new hot seat game does.
   */
  readonly seats?: readonly NewGameSeat[];
}

/** [Q48, 6] A new game, its creator in seat 1. */
export function createSetup(game: NewSetup, limits: SetupLimits): SetupState {
  const name = checkedText(game.name, limits.gameNameMaxLength, 'game name');
  const seed = checkedText(game.mapSeed, limits.seedMaxLength, 'map seed');
  const asked = game.seats ?? [{ control: 'human' }, { control: 'human' }];
  if (!Array.isArray(asked) || asked.length < limits.playerCount.min || asked.length > limits.playerCount.max) {
    throw new SetupError('invalid_action', `a game takes ${limits.playerCount.min} to ${limits.playerCount.max} players`);
  }
  const [first, ...rest] = asked;
  const creatorFigure = first?.avatarId === undefined ? firstFigure(limits) : checkedFigure(first.avatarId, limits);
  const seats: SetupSeat[] = [
    {
      id: personSeatId(game.gameMaster.userId),
      seat: 1,
      playerId: playerIdForSeat(1),
      userId: game.gameMaster.userId,
      name: game.gameMaster.displayName.slice(0, limits.nameMaxLength),
      avatarId: creatorFigure,
      control: 'human',
      thinkingSeconds: limits.defaultThinkingSeconds,
    },
  ];
  let nextSeatId = 1;
  for (const wanted of rest) {
    if (wanted?.control === 'ai') {
      seats.push({
        ...computerSeat(nextSeatId++, checkedText(wanted.name, limits.nameMaxLength, 'name'), '', limits),
        avatarId: figureNoOneElseHolds(wanted.avatarId, seats, limits),
        thinkingSeconds: checkedSeconds(wanted.thinkingSeconds, limits),
      });
    } else if (wanted?.control === 'human') {
      seats.push(openSeat(nextSeatId++, limits));
    } else {
      throw new SetupError('invalid_action', 'a seat is Human or Computer');
    }
  }
  return {
    gameId: game.gameId,
    name,
    gameMaster: game.gameMaster.userId,
    gameMasterName: game.gameMaster.displayName,
    createdAt: game.createdAt,
    phase: 'setup',
    playerCount: seats.length,
    seats: numbered(seats),
    nextSeatId,
    pending: [],
    mapSeed: seed,
    // [Q55, 42 and 43] Counted from creation, 3 days until the game master chooses.
    endsAt: game.createdAt + DEFAULT_LIFETIME_DAYS * DAY_MS,
    closedAt: null,
  };
}

/** The setup messages `applySetupAction` takes: every `setup.*`. */
export type SetupAction = Extract<
  ClientMessage,
  {
    type:
      | 'setup.requestJoin'
      | 'setup.updateRequest'
      | 'setup.withdraw'
      | 'setup.leave'
      | 'setup.updateSeat'
      | 'setup.setPlayerCount'
      | 'setup.respondToJoin'
      | 'setup.setSeed'
      | 'setup.rename'
      | 'setup.setSeatControl'
      | 'setup.setThinkingTime'
      | 'setup.cancel'
      | 'setup.start'
      | 'setup.setLifetime';
  }
>;

export interface SetupOutcome {
  readonly state: SetupState;
  /** [Q48, 11] Someone the GM just declined, to be told so. */
  readonly declined?: UserId;
}

/**
 * Applies one setup message from `by`, or throws `SetupError`. Start moves the
 * setup to `starting`; the game begins when the GM's browser sends the map
 * (`startGame`), since the server does not generate maps (§12.1).
 */
export function applySetupAction(
  state: SetupState,
  by: UserId,
  action: SetupAction,
  limits: SetupLimits,
  now: number,
): SetupOutcome {
  if (state.phase !== 'setup') throw new SetupError('invalid_action', `the game is ${state.phase}, not in setup`);
  const isGameMaster = by === state.gameMaster;
  const gameMasterOnly = (): void => {
    if (!isGameMaster) throw new SetupError('not_game_master', 'only the game master can do that');
  };
  const people = peopleOf(state);
  const seated = people.some((seat) => seat.userId === by);

  switch (action.type) {
    case 'setup.requestJoin':
    case 'setup.updateRequest': {
      const existing = state.pending.find((pending) => pending.userId === by);
      if (seated) {
        throw new SetupError(
          'invalid_action',
          action.type === 'setup.updateRequest'
            ? 'the game master has just accepted you; change your name and figure on your seat'
            : 'you already hold a seat in this game',
        );
      }
      if (action.type === 'setup.updateRequest' && existing === undefined) {
        throw new SetupError('invalid_action', 'the game master has already answered your request');
      }
      const request: JoinRequest = {
        userId: by,
        requestedName: checkedText(action.name, limits.nameMaxLength, 'name'),
        requestedAvatarId: figureNoOneElseHolds(action.avatarId, people, limits),
        requestedAt: existing?.requestedAt ?? now,
      };
      const pending =
        existing === undefined
          ? [...state.pending, request]
          : state.pending.map((other) => (other.userId === by ? request : other));
      return { state: { ...state, pending } };
    }

    case 'setup.withdraw': {
      if (!state.pending.some((request) => request.userId === by)) {
        throw new SetupError('invalid_action', 'you have no request to withdraw');
      }
      return { state: { ...state, pending: state.pending.filter((request) => request.userId !== by) } };
    }

    case 'setup.leave': {
      if (isGameMaster) throw new SetupError('invalid_action', 'the game master cannot leave; cancel the game instead');
      if (!seated) throw new SetupError('invalid_action', 'you hold no seat in this game');
      // [Q51, 22] The seat stays Human, open for someone else.
      return replaceSeat(state, personSeatId(by), openSeat(state.nextSeatId, limits), limits, 1);
    }

    case 'setup.updateSeat': {
      const target = seatNamed(state, action.seatId);
      if (isOpenSeat(target)) throw new SetupError('invalid_action', 'nobody holds that seat yet');
      const allowed = target.userId === null ? isGameMaster : target.userId === by;
      if (!allowed) {
        throw new SetupError(
          target.userId === null ? 'not_game_master' : 'invalid_action',
          target.userId === null ? 'only the game master can change a computer seat' : 'that is not your seat',
        );
      }
      // A person may take a computer's figure (Q49, 18); a computer may not
      // take anyone's.
      const others = (target.userId === null ? state.seats : people).filter((seat) => seat.id !== target.id);
      const changed: SetupSeat = {
        ...target,
        name: checkedText(action.name, limits.nameMaxLength, 'name'),
        avatarId: figureNoOneElseHolds(action.avatarId, others, limits),
      };
      return replaceSeat(state, target.id, changed, limits);
    }

    case 'setup.setSeatControl': {
      gameMasterOnly();
      const target = seatNamed(state, action.seatId);
      if (action.control !== 'human' && action.control !== 'ai') {
        throw new SetupError('invalid_action', 'a seat is Human or Computer');
      }
      if (target.userId === state.gameMaster) throw new SetupError('invalid_action', 'your own seat is always Human');
      if (target.userId !== null) {
        throw new SetupError('invalid_action', `${target.name} holds that seat; only they can leave it`);
      }
      if (target.control === action.control) return { state };
      const replacement =
        action.control === 'ai'
          ? computerSeat(state.nextSeatId, nextComputerName(state.seats), freeFigure(state.seats, limits), limits)
          : openSeat(state.nextSeatId, limits);
      return replaceSeat(state, target.id, replacement, limits, 1);
    }

    case 'setup.setPlayerCount': {
      gameMasterOnly();
      const count = action.count;
      if (!Number.isInteger(count) || count < limits.playerCount.min || count > limits.playerCount.max) {
        throw new SetupError('invalid_action', `a game takes ${limits.playerCount.min} to ${limits.playerCount.max} players`);
      }
      if (count < people.length) throw new SetupError('invalid_action', `${people.length} seats are already taken`);
      // New seats are Human, as on the hot seat screen; fewer seats drop the
      // last ones nobody holds.
      const seats = [...state.seats];
      let nextSeatId = state.nextSeatId;
      while (seats.length < count) seats.push(openSeat(nextSeatId++, limits));
      for (let at = seats.length - 1; seats.length > count && at >= 0; at--) {
        if (seats[at]?.userId === null) seats.splice(at, 1);
      }
      return { state: { ...state, playerCount: count, seats: settled(seats, limits), nextSeatId } };
    }

    case 'setup.respondToJoin': {
      gameMasterOnly();
      const request = state.pending.find((pending) => pending.userId === action.userId);
      if (request === undefined) throw new SetupError('invalid_action', 'there is no such request');
      const pending = state.pending.filter((other) => other.userId !== action.userId);
      if (!action.accept) return { state: { ...state, pending }, declined: action.userId };
      const open = state.seats.find(isOpenSeat);
      if (open === undefined) {
        throw new SetupError('game_full', 'no Human seat is free; make a seat Human or raise the number of players first');
      }
      // [Q49, 19] The first accepted gets a figure two asked for; the other
      // picks again before they can be accepted.
      const holder = people.find((seat) => seat.avatarId === request.requestedAvatarId);
      if (holder !== undefined) {
        throw new SetupError(
          'invalid_action',
          `${holder.name} has taken the figure ${request.requestedName} asked for; ${request.requestedName} has to pick another before you can accept them`,
        );
      }
      const joined: SetupSeat = {
        ...open,
        id: personSeatId(request.userId),
        userId: request.userId,
        name: request.requestedName,
        avatarId: request.requestedAvatarId,
      };
      return replaceSeat({ ...state, pending }, open.id, joined, limits);
    }

    case 'setup.setSeed': {
      gameMasterOnly();
      return { state: { ...state, mapSeed: checkedText(action.seed, limits.seedMaxLength, 'map seed') } };
    }

    case 'setup.rename': {
      gameMasterOnly();
      return { state: { ...state, name: checkedText(action.name, limits.gameNameMaxLength, 'game name') } };
    }

    case 'setup.setThinkingTime': {
      gameMasterOnly();
      const target = seatNamed(state, action.seatId);
      if (target.control !== 'ai') throw new SetupError('invalid_action', 'only a computer seat has a thinking time');
      return replaceSeat(state, target.id, { ...target, thinkingSeconds: checkedSeconds(action.seconds, limits) }, limits);
    }

    case 'setup.cancel': {
      gameMasterOnly();
      return { state: { ...state, phase: 'cancelled', pending: [], closedAt: now } };
    }

    case 'setup.setLifetime': {
      // [Q55, 43] "Game lasts" 1, 3, 7 or 14 days, counted from creation.
      gameMasterOnly();
      if (!LIFETIME_DAYS.includes(action.days)) {
        throw new SetupError('invalid_action', `a game lasts ${LIFETIME_DAYS.join(', ')} days`);
      }
      const endsAt = state.createdAt + action.days * DAY_MS;
      if (endsAt <= now) throw new SetupError('invalid_action', `this game is already more than ${action.days} days old`);
      return { state: { ...state, endsAt } };
    }

    case 'setup.start': {
      gameMasterOnly();
      // [Q48, 12 and 16] No seat has to be filled by a person: the computer
      // plays every Human seat nobody has taken, even every seat but the game
      // master's. Each gets a name and figure as a new computer seat does.
      let nextSeatId = state.nextSeatId;
      const seats = [...state.seats];
      seats.forEach((seat, at) => {
        if (isOpenSeat(seat)) seats[at] = computerSeat(nextSeatId++, nextComputerName(seats), freeFigure(seats, limits), limits);
      });
      return { state: { ...state, phase: 'starting', seats: numbered(seats), nextSeatId } };
    }
  }
}

/**
 * The game as it starts, from a setup in `starting` and the map the GM's
 * browser generated from its seed (§12.1). The server takes the map on trust
 * (`docs/STACK.md` §5) beyond checking it is the map for this seed.
 */
export function startGame(state: SetupState, map: GameMap): { readonly setup: SetupState; readonly game: GameState } {
  if (state.phase !== 'starting') throw new SetupError('invalid_action', 'the game is not starting');
  if (map.seed !== state.mapSeed) throw new SetupError('invalid_action', 'that map is for another seed');
  const setup: SetupState = { ...state, phase: 'started', pending: [] };
  return { setup, game: openingStateOf(setup, map) };
}

/* --------------------------------- seats --------------------------------- */

function peopleOf(state: SetupState): SetupSeat[] {
  return state.seats.filter((seat) => seat.userId !== null);
}

function playerIdForSeat(seat: number) {
  return asPlayerId(`seat-${seat}`);
}

function personSeatId(userId: UserId): string {
  return `person:${userId}`;
}

/** A Human seat nobody holds yet ([Q51, 22]). */
function openSeat(n: number, limits: SetupLimits): SetupSeat {
  return {
    id: `open:${n}`,
    seat: 0,
    playerId: playerIdForSeat(0),
    userId: null,
    name: '',
    avatarId: '',
    control: 'human',
    thinkingSeconds: limits.defaultThinkingSeconds,
  };
}

function computerSeat(n: number, name: string, avatarId: string, limits: SetupLimits): SetupSeat {
  return {
    id: `computer:${n}`,
    seat: 0,
    playerId: playerIdForSeat(0),
    userId: null,
    name,
    avatarId,
    control: 'ai',
    thinkingSeconds: limits.defaultThinkingSeconds,
  };
}

/**
 * The seat `id` names, or a refusal saying why it has gone: a computer or open
 * seat is replaced when the game master switches it, or a person takes it.
 */
function seatNamed(state: SetupState, id: string): SetupSeat {
  const seat = state.seats.find((candidate) => candidate.id === id);
  if (seat !== undefined) return seat;
  throw new SetupError(
    'invalid_action',
    id.startsWith('computer:') || id.startsWith('open:')
      ? 'that seat has just changed; look again'
      : 'that seat is no longer in the game',
  );
}

/** `state` with seat `id` replaced by `seat`, `used` seat ids later. */
function replaceSeat(state: SetupState, id: string, seat: SetupSeat, limits: SetupLimits, used = 0): SetupOutcome {
  const seats = state.seats.map((other) => (other.id === id ? seat : other));
  return { state: { ...state, seats: settled(seats, limits), nextSeatId: state.nextSeatId + used } };
}

/** Seat numbers and player ids, from the seats' order. */
function numbered(seats: readonly SetupSeat[]): SetupSeat[] {
  return seats.map((seat, index) => ({ ...seat, seat: index + 1, playerId: playerIdForSeat(index + 1) }));
}

function settled(seats: readonly SetupSeat[], limits: SetupLimits): SetupSeat[] {
  return settleFigures(numbered(seats), limits);
}

function nextComputerName(seats: readonly SetupSeat[]): string {
  const taken = new Set(seats.map((seat) => seat.name));
  for (let n = 1; ; n++) if (!taken.has(`Computer ${n}`)) return `Computer ${n}`;
}

function firstFigure(limits: SetupLimits): string {
  const figure = limits.figures[0];
  if (figure === undefined) throw new RangeError('no figures to choose from');
  return figure;
}

/** The first figure no seat holds, or the first figure if all are held. */
function freeFigure(seats: readonly SetupSeat[], limits: SetupLimits): string {
  return limits.figures.find((id) => !seats.some((seat) => seat.avatarId === id)) ?? firstFigure(limits);
}

/**
 * [Q49, 18] Keeps every seat's figure its own. People's figures are already
 * their own (the checks below refuse anything else); a computer whose figure a
 * person, or an earlier computer, holds switches to the first figure nobody
 * holds. There are more figures than seats, so there always is one.
 */
function settleFigures(seats: readonly SetupSeat[], limits: SetupLimits): SetupSeat[] {
  const inUse = new Set(seats.filter((seat) => seat.userId !== null).map((seat) => seat.avatarId));
  const clashing = new Set<string>();
  for (const seat of seats) {
    if (seat.control !== 'ai') continue;
    if (inUse.has(seat.avatarId)) clashing.add(seat.id);
    else inUse.add(seat.avatarId);
  }
  return seats.map((seat) => {
    if (!clashing.has(seat.id)) return seat;
    const free = limits.figures.find((id) => !inUse.has(id));
    if (free === undefined) return seat;
    inUse.add(free);
    return { ...seat, avatarId: free };
  });
}

/* -------------------------------- checking -------------------------------- */

function checkedText(value: unknown, maxLength: number, what: string): string {
  if (typeof value !== 'string') throw new SetupError('invalid_action', `the ${what} is missing`);
  const text = value.trim();
  if (text.length === 0) throw new SetupError('invalid_action', `the ${what} is empty`);
  if (text.length > maxLength) throw new SetupError('invalid_action', `the ${what} is longer than ${maxLength} characters`);
  return text;
}

/** [Q41, Q51 24] A computer seat's thinking time: whole seconds within §11's range. */
function checkedSeconds(value: unknown, limits: SetupLimits): number {
  const range = limits.thinkingSeconds;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new SetupError('invalid_action', `thinking time is whole seconds from ${range.min} to ${range.max}`);
  }
  return value;
}

function checkedFigure(value: unknown, limits: SetupLimits): string {
  if (typeof value !== 'string' || !limits.figures.includes(value)) {
    throw new SetupError('invalid_action', 'there is no such figure');
  }
  return value;
}

/**
 * [Q48, 10] A figure one of `others` holds is not on offer. A refusal names
 * the holder, since it usually means they took it a moment ago.
 */
function figureNoOneElseHolds(value: unknown, others: readonly SetupSeat[], limits: SetupLimits): string {
  const figure = checkedFigure(value, limits);
  const holder = others.find((seat) => seat.avatarId === figure);
  if (holder !== undefined) throw new SetupError('invalid_action', `${holder.name} holds that figure now; pick another`);
  return figure;
}
