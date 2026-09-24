import type { IntRange, Ruleset } from '@adventure/config';
import {
  asPlayerId,
  createGameState,
  startingNodeFor,
  type GameId,
  type GameMap,
  type GameState,
  type UserId,
} from '@adventure/core';
import type { ClientMessage, JoinRequest, ProtocolErrorCode, SetupSeat, SetupState } from '@adventure/protocol';

/**
 * [SOURCE §3] §6.1's setup flow, as pure functions over `SetupState`: the GM
 * chooses the player count, users ask to join, the GM accepts or declines,
 * each player picks a name and figure, and the GM starts. `GameSession` runs
 * these one message at a time and does the storing and sending.
 *
 * [Q48] Andrei's answers settle the details: the GM plays, always in seat 1;
 * later seats go in the order the GM accepts people (§6's "whatever is most
 * convenient", which acceptance order also is); the GM may start with seats
 * empty, alone if they like, and a computer plays each empty seat. Computer
 * seats are "Computer 1", "Computer 2" and so on, each with a free figure, and
 * the GM may rename them and change their figures before the start. One
 * thinking time covers all of them.
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
 * from `@adventure/config`, inside `createGameState`, so computers, holding the
 * last seats, start with the most.
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
}

/** [Q48, 6 and 7] A new game, its creator in seat 1 and a computer in seat 2. */
export function createSetup(game: NewSetup, limits: SetupLimits): SetupState {
  const name = checkedText(game.name, limits.gameNameMaxLength, 'game name');
  const seed = checkedText(game.mapSeed, limits.seedMaxLength, 'map seed');
  const creator: SetupSeat = {
    id: personSeatId(game.gameMaster.userId),
    seat: 1,
    playerId: playerIdForSeat(1),
    userId: game.gameMaster.userId,
    name: game.gameMaster.displayName.slice(0, limits.nameMaxLength),
    avatarId: firstFigure(limits),
    control: 'human',
  };
  return withSeats(
    {
      gameId: game.gameId,
      name,
      gameMaster: game.gameMaster.userId,
      gameMasterName: game.gameMaster.displayName,
      createdAt: game.createdAt,
      phase: 'setup',
      playerCount: limits.playerCount.min,
      seats: [creator],
      nextComputer: 1,
      pending: [],
      mapSeed: seed,
      thinkingSeconds: limits.defaultThinkingSeconds,
    },
    [creator],
    [],
    limits,
  );
}

/** The setup messages `applySetupAction` takes: every `setup.*` but Start. */
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
      | 'setup.setThinkingTime'
      | 'setup.cancel'
      | 'setup.start';
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
  const computers = computersOf(state);
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
      return { state: withSeats(state, people.filter((seat) => seat.userId !== by), computers, limits) };
    }

    case 'setup.updateSeat': {
      const target = state.seats.find((seat) => seat.id === action.seatId);
      if (target === undefined) {
        throw new SetupError(
          'invalid_action',
          isComputerSeatId(action.seatId)
            ? 'that computer seat has just made way for a person or been removed'
            : 'that seat is no longer in the game',
        );
      }
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
      const replace = (seats: readonly SetupSeat[]): SetupSeat[] => seats.map((seat) => (seat.id === target.id ? changed : seat));
      return { state: withSeats(state, replace(people), replace(computers), limits) };
    }

    case 'setup.setPlayerCount': {
      gameMasterOnly();
      const count = action.count;
      if (!Number.isInteger(count) || count < limits.playerCount.min || count > limits.playerCount.max) {
        throw new SetupError('invalid_action', `a game takes ${limits.playerCount.min} to ${limits.playerCount.max} players`);
      }
      if (count < people.length) throw new SetupError('invalid_action', `${people.length} seats are already taken`);
      return { state: withSeats({ ...state, playerCount: count }, people, computers, limits) };
    }

    case 'setup.respondToJoin': {
      gameMasterOnly();
      const request = state.pending.find((pending) => pending.userId === action.userId);
      if (request === undefined) throw new SetupError('invalid_action', 'there is no such request');
      const pending = state.pending.filter((other) => other.userId !== action.userId);
      if (!action.accept) return { state: { ...state, pending }, declined: action.userId };
      if (people.length >= state.playerCount) {
        throw new SetupError('game_full', 'every seat is taken; raise the player count first');
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
        id: personSeatId(request.userId),
        seat: people.length + 1,
        playerId: playerIdForSeat(people.length + 1),
        userId: request.userId,
        name: request.requestedName,
        avatarId: request.requestedAvatarId,
        control: 'human',
      };
      return { state: withSeats({ ...state, pending }, [...people, joined], computers, limits) };
    }

    case 'setup.setSeed': {
      gameMasterOnly();
      return { state: { ...state, mapSeed: checkedText(action.seed, limits.seedMaxLength, 'map seed') } };
    }

    case 'setup.setThinkingTime': {
      gameMasterOnly();
      const seconds = action.seconds;
      const range = limits.thinkingSeconds;
      if (!Number.isInteger(seconds) || seconds < range.min || seconds > range.max) {
        throw new SetupError('invalid_action', `thinking time is whole seconds from ${range.min} to ${range.max}`);
      }
      return { state: { ...state, thinkingSeconds: seconds } };
    }

    case 'setup.cancel': {
      gameMasterOnly();
      return { state: { ...state, phase: 'cancelled', pending: [] } };
    }

    case 'setup.start': {
      gameMasterOnly();
      // [Q48, 12 and 16] No seat has to be filled by a person: computers play
      // the rest, even every seat but the game master's.
      return { state: { ...state, phase: 'starting' } };
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
  const game = createGameState({
    id: state.gameId,
    map,
    players: state.seats.map((seat) => ({
      id: seat.playerId,
      name: seat.name,
      avatarId: seat.avatarId,
      control: seat.control,
    })),
    startingNode: startingNodeFor(map),
  });
  return { setup: { ...state, phase: 'started', pending: [] }, game };
}

/* --------------------------------- seats --------------------------------- */

function peopleOf(state: SetupState): SetupSeat[] {
  return state.seats.filter((seat) => seat.userId !== null);
}

function computersOf(state: SetupState): SetupSeat[] {
  return state.seats.filter((seat) => seat.userId === null);
}

function playerIdForSeat(seat: number) {
  return asPlayerId(`seat-${seat}`);
}

function personSeatId(userId: UserId): string {
  return `person:${userId}`;
}

function isComputerSeatId(id: string): boolean {
  return id.startsWith('computer:');
}

/**
 * Lays the seats out again: people first, in the order given, then as many
 * computers as the player count leaves room for. Computers keep their names
 * and figures in order; when there are fewer, the last go, and when there are
 * more, new ones get the lowest "Computer N" not in use and a free figure.
 * Then any computer whose figure a person now holds switches to a free one.
 */
function withSeats(
  state: SetupState,
  people: readonly SetupSeat[],
  computers: readonly SetupSeat[],
  limits: SetupLimits,
): SetupState {
  const room = state.playerCount - people.length;
  const kept = computers.slice(0, room);
  const seats: SetupSeat[] = people.map((seat, index) => ({
    ...seat,
    seat: index + 1,
    playerId: playerIdForSeat(index + 1),
  }));
  for (const computer of kept) seats.push({ ...computer, userId: null, control: 'ai' });
  let nextComputer = state.nextComputer;
  while (seats.length < state.playerCount) {
    seats.push({
      id: `computer:${nextComputer++}`,
      seat: 0,
      playerId: playerIdForSeat(0),
      userId: null,
      name: nextComputerName(seats),
      avatarId: freeFigure(seats, limits),
      control: 'ai',
    });
  }
  const numbered = seats.map((seat, index) => ({ ...seat, seat: index + 1, playerId: playerIdForSeat(index + 1) }));
  return { ...state, seats: settleFigures(numbered, limits), nextComputer };
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
    if (seat.userId !== null) continue;
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
