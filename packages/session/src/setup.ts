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
    case 'setup.requestJoin': {
      if (seated) throw new SetupError('invalid_action', 'you already hold a seat in this game');
      const request: JoinRequest = {
        userId: by,
        requestedName: checkedText(action.name, limits.nameMaxLength, 'name'),
        requestedAvatarId: unheldFigure(action.avatarId, people, limits),
        requestedAt: state.pending.find((pending) => pending.userId === by)?.requestedAt ?? now,
      };
      const pending = state.pending.some((existing) => existing.userId === by)
        ? state.pending.map((existing) => (existing.userId === by ? request : existing))
        : [...state.pending, request];
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
      const target = state.seats.find((seat) => seat.seat === action.seat);
      if (target === undefined) throw new SetupError('invalid_action', `there is no seat ${action.seat}`);
      const allowed = target.userId === null ? isGameMaster : target.userId === by;
      if (!allowed) {
        throw new SetupError(
          target.userId === null ? 'not_game_master' : 'invalid_action',
          target.userId === null ? 'only the game master can change a computer seat' : 'that is not your seat',
        );
      }
      const changed: SetupSeat = {
        ...target,
        name: checkedText(action.name, limits.nameMaxLength, 'name'),
        avatarId: unheldFigure(
          action.avatarId,
          people.filter((seat) => seat.seat !== target.seat),
          limits,
        ),
      };
      const replace = (seats: readonly SetupSeat[]): SetupSeat[] =>
        seats.map((seat) => (seat.seat === target.seat ? changed : seat));
      return { state: withSeats(state, replace(people), replace(computers), limits, changed) };
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
      const joined: SetupSeat = {
        seat: people.length + 1,
        playerId: playerIdForSeat(people.length + 1),
        userId: request.userId,
        name: request.requestedName,
        avatarId: request.requestedAvatarId,
        control: 'human',
      };
      return { state: withSeats({ ...state, pending }, [...people, joined], computers, limits, joined) };
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

/**
 * Lays the seats out again: people first, in the order given, then as many
 * computers as the player count leaves room for. Computers keep their names
 * and figures in order; when there are fewer, the last go, and when there are
 * more, new ones get the lowest "Computer N" not in use and a free figure.
 *
 * `changed` is the seat whose figure just changed, if any, for the figure
 * rules below.
 */
function withSeats(
  state: SetupState,
  people: readonly SetupSeat[],
  computers: readonly SetupSeat[],
  limits: SetupLimits,
  changed?: SetupSeat,
): SetupState {
  const room = state.playerCount - people.length;
  const kept = computers.slice(0, room);
  const seats: SetupSeat[] = people.map((seat, index) => ({
    ...seat,
    seat: index + 1,
    playerId: playerIdForSeat(index + 1),
  }));
  for (const computer of kept) seats.push({ ...computer, userId: null, control: 'ai' });
  while (seats.length < state.playerCount) {
    seats.push({
      seat: 0,
      playerId: playerIdForSeat(0),
      userId: null,
      name: nextComputerName(seats),
      avatarId: freeFigure(seats, limits),
      control: 'ai',
    });
  }
  const numbered = seats.map((seat, index) => ({ ...seat, seat: index + 1, playerId: playerIdForSeat(index + 1) }));
  return { ...state, seats: settleFigures(numbered, limits, changed) };
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
 * Keeps every seat's figure its own. **Waiting on Andrei (phase 6 details 18
 * and 19):** what happens when a person takes a figure a computer holds, and
 * when two requests name the same figure.
 */
function settleFigures(seats: readonly SetupSeat[], _limits: SetupLimits, _changed?: SetupSeat): SetupSeat[] {
  return [...seats];
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

/** [Q48, 10] A figure another person in the game holds is not on offer. */
function unheldFigure(value: unknown, others: readonly SetupSeat[], limits: SetupLimits): string {
  const figure = checkedFigure(value, limits);
  if (others.some((seat) => seat.avatarId === figure)) {
    throw new SetupError('invalid_action', 'someone else in the game holds that figure');
  }
  return figure;
}
