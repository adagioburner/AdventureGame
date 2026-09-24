var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../packages/core/src/errors.ts
var NotImplementedError = class extends Error {
  static {
    __name(this, "NotImplementedError");
  }
  gdd;
  constructor(what, gdd) {
    super(`Not implemented: ${what} (see ${gdd})`);
    this.name = "NotImplementedError";
    this.gdd = gdd;
  }
};
var RuleViolationError = class extends Error {
  static {
    __name(this, "RuleViolationError");
  }
  constructor(message) {
    super(message);
    this.name = "RuleViolationError";
  }
};

// ../../packages/core/src/ids.ts
var asPlayerId = /* @__PURE__ */ __name((s) => s, "asPlayerId");
var asGameId = /* @__PURE__ */ __name((s) => s, "asGameId");
var asUserId = /* @__PURE__ */ __name((s) => s, "asUserId");

// ../../packages/core/src/rng.ts
function hashSeed(seed) {
  let h = 1779033703 ^ seed.length;
  const out = [];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = h << 13 | h >>> 19;
    }
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    out.push((h ^= h >>> 16) >>> 0);
  }
  return [out[0] ?? 1, out[1] ?? 2, out[2] ?? 3, out[3] ?? 4];
}
__name(hashSeed, "hashSeed");
function createRng(seed) {
  let [a, b, c, d] = hashSeed(seed);
  const nextUint32 = /* @__PURE__ */ __name(() => {
    const t = a + b | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    d = d + 1 | 0;
    const next = t + d | 0;
    c = c + next | 0;
    return next >>> 0;
  }, "nextUint32");
  const rng = {
    nextUint32,
    nextFloat: /* @__PURE__ */ __name(() => nextUint32() / 4294967296, "nextFloat"),
    nextInt(maxExclusive) {
      if (maxExclusive <= 0) throw new RangeError(`nextInt bound must be positive, got ${maxExclusive}`);
      return Math.floor(rng.nextFloat() * maxExclusive);
    },
    nextIntInclusive(min, max) {
      if (max < min) throw new RangeError(`nextIntInclusive: max ${max} < min ${min}`);
      return min + rng.nextInt(max - min + 1);
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("pick from empty array");
      return items[rng.nextInt(items.length)];
    },
    weightedPick(items, weights) {
      if (items.length === 0) throw new RangeError("weightedPick from empty array");
      if (items.length !== weights.length) throw new RangeError("weightedPick: length mismatch");
      let total = 0;
      for (const weight of weights) {
        if (!(weight >= 0) || !Number.isFinite(weight)) {
          throw new RangeError(`weightedPick: weight must be finite and non-negative, got ${weight}`);
        }
        total += weight;
      }
      if (total <= 0) throw new RangeError("weightedPick: weights sum to zero");
      let roll = rng.nextFloat() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    shuffle(items) {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
      }
      return copy;
    },
    fork: /* @__PURE__ */ __name((label) => createRng(`${seed}::${label}`), "fork")
  };
  return rng;
}
__name(createRng, "createRng");
var SEED_WORDS = ["amber", "birch", "cairn", "delta", "ember", "fjord", "glade", "heath", "islet", "juniper"];
function friendlySeed(random) {
  const pick = /* @__PURE__ */ __name(() => SEED_WORDS[Math.floor(random() * SEED_WORDS.length)] ?? "amber", "pick");
  return `${pick()}-${pick()}-${Math.floor(random() * 1e3)}`;
}
__name(friendlySeed, "friendlySeed");

// ../../packages/config/src/defaults.ts
var DEFAULT_GAME_CONFIG = {
  map: {
    MAP_NODE_COUNT: 240,
    MAP_EDGE_COUNT: 300,
    MAP_COORDINATE_SPACE: 1e6,
    LEAF_COUNT: { min: 30, max: 45 },
    TERRAIN_AREA_SHARE: { plains: 0.45, forest: 0.3, mountain: 0.25 },
    COMPACTNESS_MAX: 25,
    VALLEY_COUNT: { min: 2, max: 4 },
    VALLEY_WIDTH: 1,
    VALLEY_LENGTH: { min: 5, max: 12 },
    EDGE_PRUNE_JITTER: 10
  },
  pois: {
    POI_COUNT: { plains: 25, forest: 20, mountain: 15 },
    OVERFLOW_LEAF_STAMINA_UNITS: 1,
    // §11 says 2; [SOURCE §5.2, chat] caps the formula at 0, where 0 = unguarded.
    GUARD_STRENGTH: { min: 0, max: 10 }
  },
  balancing: {
    REMOTENESS_WEIGHT: 4,
    GOLD_WEIGHT: 3,
    REMOTENESS_WEIGHT_FOR_DISTRIBUTION: 2,
    REWARD_SWAP_PASSES: 5,
    CLOSE_CANDIDATE_COUNT: 10,
    REMOTENESS_SIMULATION_RUNS: 100
  },
  movement: {
    STAMINA_COST: { plains: 1, forest: 2, mountain: 3 },
    REST_STAMINA_GAIN: 5
  },
  players: {
    PLAYER_COUNT: { min: 2, max: 5 },
    STARTING_STAMINA_BASE: 30,
    STARTING_STAMINA_INCREMENT: 10
  },
  combat: {
    GUARD_DIE: { count: 1, sides: 6 }
  },
  ai: {
    MCTS_TIME_BUDGET_PER_MOVE_MS: 1e4,
    // UCB1's textbook constant. See the tuning caveat on the field.
    MCTS_EXPLORATION_CONSTANT: Math.SQRT2,
    MIN_REACHABLE_NODES_FOR_REST: 3,
    SIMULATION_TURN_CAP: 250,
    THINKING_TIME_SECONDS: { min: 1, max: 60 }
  }
};
var DEFAULT_ENGINEERING_CONFIG = {
  MAX_GENERATION_ATTEMPTS: 50,
  POISSON_RADIUS_FACTOR: 0.815,
  // Every design value is decided; see the note on `PendingConfig`.
  pending: {}
};

// ../../packages/config/src/content.ts
var DEFAULT_REWARD_TABLE = {
  plains: [
    { kind: "plains_move", guard: null, totalUnits: 20, poiCount: 10 },
    { kind: "forest_move", guard: null, totalUnits: 15, poiCount: 7 },
    { kind: "magic", guard: null, totalUnits: 10, poiCount: 6 },
    // [SOURCE §1.1] Informally "cities".
    { kind: "gold", guard: "fighting", totalUnits: 10, poiCount: 2 }
  ],
  forest: [
    { kind: "mountain_move", guard: null, totalUnits: 15, poiCount: 8 },
    { kind: "fighting", guard: null, totalUnits: 15, poiCount: 8 },
    { kind: "gold", guard: "fighting", totalUnits: 5, poiCount: 4 }
  ],
  mountain: [
    // Mountain gold is split by guard type. Both rows are `kind: 'gold'`:
    // the split is a sub-partition of the gold group, not an extra kind.
    { kind: "gold", guard: "fighting", totalUnits: 20, poiCount: 10 },
    { kind: "gold", guard: "magic", totalUnits: 10, poiCount: 5 }
  ]
};
var DEFAULT_GAME_CONTENT = {
  REWARD_TABLE: DEFAULT_REWARD_TABLE
};

// ../../packages/config/src/index.ts
var DEFAULT_RULESET = {
  config: DEFAULT_GAME_CONFIG,
  content: DEFAULT_GAME_CONTENT,
  engineering: DEFAULT_ENGINEERING_CONFIG
};
function startingStaminaForSeat(seat, ruleset) {
  const { STARTING_STAMINA_BASE, STARTING_STAMINA_INCREMENT } = ruleset.config.players;
  return STARTING_STAMINA_BASE + (seat - 1) * STARTING_STAMINA_INCREMENT;
}
__name(startingStaminaForSeat, "startingStaminaForSeat");

// ../../packages/core/src/gamemap.ts
function chooseStartingNode(map, rng) {
  const candidates = map.graph.nodes.filter((node) => node.terrain === "plains" && !map.poiByNode.has(node.id)).map((node) => node.id);
  if (candidates.length === 0) {
    throw new RangeError("no non-POI plains node available as a starting position");
  }
  return rng.pick(candidates);
}
__name(chooseStartingNode, "chooseStartingNode");
function startingNodeFor(map) {
  return chooseStartingNode(map, createRng(map.seed).fork("starting-node"));
}
__name(startingNodeFor, "startingNodeFor");

// ../../packages/core/src/player.ts
function initialStats(startingStamina) {
  return {
    plains_move: 0,
    forest_move: 0,
    mountain_move: 0,
    fighting: 0,
    magic: 0,
    gold: 0,
    stamina: startingStamina
  };
}
__name(initialStats, "initialStats");

// ../../packages/core/src/rules/movement.ts
function refreshAllowance(stats) {
  return {
    plains: stats.plains_move,
    forest: stats.forest_move,
    mountain: stats.mountain_move
  };
}
__name(refreshAllowance, "refreshAllowance");

// ../../packages/core/src/rules/setup.ts
function createGameState(game) {
  const { PLAYER_COUNT } = game.map.ruleset.config.players;
  if (game.players.length < PLAYER_COUNT.min || game.players.length > PLAYER_COUNT.max) {
    throw new RuleViolationError(
      `a game takes ${PLAYER_COUNT.min}\u2013${PLAYER_COUNT.max} players, got ${game.players.length}`
    );
  }
  const players = game.players.map((player, index) => {
    const seat = index + 1;
    return {
      id: player.id,
      seat,
      name: player.name,
      avatarId: player.avatarId,
      control: player.control,
      resigned: false,
      // [SOURCE §2, chat] Every stat starts at zero except stamina, which is
      // higher the later you move — the compensation for seat order.
      stats: initialStats(startingStaminaForSeat(seat, game.map.ruleset)),
      position: game.startingNode,
      plannedPath: null
    };
  });
  const first = players[0];
  if (first === void 0) throw new RuleViolationError("a game needs at least one player");
  const unclaimed = { claimedBy: null, claimedOnTurn: null };
  return {
    id: game.id,
    map: game.map,
    players,
    turn: {
      number: 1,
      activeSeat: first.seat,
      allowance: refreshAllowance(first.stats)
    },
    poiRuntime: game.map.pois.map(() => unclaimed),
    messageBoard: [],
    status: "in_progress",
    winners: []
  };
}
__name(createGameState, "createGameState");

// src/env.ts
var USER_HEADER = "X-Adventure-User";
var NAME_HEADER = "X-Adventure-Name";
function lobbyOf(env) {
  return env.LOBBY.get(env.LOBBY.idFromName("lobby"));
}
__name(lobbyOf, "lobbyOf");
function roomOf(env, gameId) {
  return env.GAMES.get(env.GAMES.idFromName(gameId));
}
__name(roomOf, "roomOf");

// src/room.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// ../../packages/protocol/src/wire.ts
var MAP_TAG = "$map";
function replacer(_key, value) {
  return value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value;
}
__name(replacer, "replacer");
function reviver(_key, value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const entries = value[MAP_TAG];
    if (keys.length === 1 && Array.isArray(entries)) return new Map(entries);
  }
  return value;
}
__name(reviver, "reviver");
function encodeMessage(message) {
  return JSON.stringify(message, replacer);
}
__name(encodeMessage, "encodeMessage");
var CLIENT_MESSAGE_TYPE_RECORD = {
  "lobby.create": true,
  "setup.requestJoin": true,
  "setup.updateRequest": true,
  "setup.withdraw": true,
  "setup.leave": true,
  "setup.updateSeat": true,
  "setup.setPlayerCount": true,
  "setup.respondToJoin": true,
  "setup.setSeed": true,
  "setup.setThinkingTime": true,
  "setup.cancel": true,
  "setup.start": true,
  "turn.plan": true,
  "turn.end": true,
  "turn.rest": true,
  "gm.forceTurn": true,
  "gm.setControl": true,
  "player.resign": true,
  "board.post": true,
  "gm.mapGenerated": true,
  "gm.aiMove": true
};
var CLIENT_MESSAGE_TYPES = new Set(Object.keys(CLIENT_MESSAGE_TYPE_RECORD));
var WireError = class extends Error {
  static {
    __name(this, "WireError");
  }
  name = "WireError";
};
function decodeClientMessage(text) {
  let value;
  try {
    value = JSON.parse(text, reviver);
  } catch {
    throw new WireError("not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError("not an object");
  const type = value.type;
  if (typeof type !== "string" || !CLIENT_MESSAGE_TYPES.has(type)) throw new WireError(`unknown message type`);
  return value;
}
__name(decodeClientMessage, "decodeClientMessage");

// ../../packages/session/src/ports.ts
var GAME_MASTER_ABSENCE_BEHAVIOUR = "stall";

// ../../packages/session/src/setup.ts
function setupLimitsFor(ruleset, figures) {
  return {
    playerCount: ruleset.config.players.PLAYER_COUNT,
    thinkingSeconds: ruleset.config.ai.THINKING_TIME_SECONDS,
    defaultThinkingSeconds: Math.round(ruleset.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1e3),
    figures,
    nameMaxLength: 24,
    gameNameMaxLength: 40,
    seedMaxLength: 64
  };
}
__name(setupLimitsFor, "setupLimitsFor");
var SetupError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  static {
    __name(this, "SetupError");
  }
  name = "SetupError";
};
function createSetup(game, limits) {
  const name = checkedText(game.name, limits.gameNameMaxLength, "game name");
  const seed = checkedText(game.mapSeed, limits.seedMaxLength, "map seed");
  const creator = {
    id: personSeatId(game.gameMaster.userId),
    seat: 1,
    playerId: playerIdForSeat(1),
    userId: game.gameMaster.userId,
    name: game.gameMaster.displayName.slice(0, limits.nameMaxLength),
    avatarId: firstFigure(limits),
    control: "human"
  };
  return withSeats(
    {
      gameId: game.gameId,
      name,
      gameMaster: game.gameMaster.userId,
      gameMasterName: game.gameMaster.displayName,
      createdAt: game.createdAt,
      phase: "setup",
      playerCount: limits.playerCount.min,
      seats: [creator],
      nextComputer: 1,
      pending: [],
      mapSeed: seed,
      thinkingSeconds: limits.defaultThinkingSeconds
    },
    [creator],
    [],
    limits
  );
}
__name(createSetup, "createSetup");
function applySetupAction(state, by, action, limits, now) {
  if (state.phase !== "setup") throw new SetupError("invalid_action", `the game is ${state.phase}, not in setup`);
  const isGameMaster = by === state.gameMaster;
  const gameMasterOnly = /* @__PURE__ */ __name(() => {
    if (!isGameMaster) throw new SetupError("not_game_master", "only the game master can do that");
  }, "gameMasterOnly");
  const people = peopleOf(state);
  const computers = computersOf(state);
  const seated = people.some((seat) => seat.userId === by);
  switch (action.type) {
    case "setup.requestJoin":
    case "setup.updateRequest": {
      const existing = state.pending.find((pending2) => pending2.userId === by);
      if (seated) {
        throw new SetupError(
          "invalid_action",
          action.type === "setup.updateRequest" ? "the game master has just accepted you; change your name and figure on your seat" : "you already hold a seat in this game"
        );
      }
      if (action.type === "setup.updateRequest" && existing === void 0) {
        throw new SetupError("invalid_action", "the game master has already answered your request");
      }
      const request = {
        userId: by,
        requestedName: checkedText(action.name, limits.nameMaxLength, "name"),
        requestedAvatarId: figureNoOneElseHolds(action.avatarId, people, limits),
        requestedAt: existing?.requestedAt ?? now
      };
      const pending = existing === void 0 ? [...state.pending, request] : state.pending.map((other) => other.userId === by ? request : other);
      return { state: { ...state, pending } };
    }
    case "setup.withdraw": {
      if (!state.pending.some((request) => request.userId === by)) {
        throw new SetupError("invalid_action", "you have no request to withdraw");
      }
      return { state: { ...state, pending: state.pending.filter((request) => request.userId !== by) } };
    }
    case "setup.leave": {
      if (isGameMaster) throw new SetupError("invalid_action", "the game master cannot leave; cancel the game instead");
      if (!seated) throw new SetupError("invalid_action", "you hold no seat in this game");
      return { state: withSeats(state, people.filter((seat) => seat.userId !== by), computers, limits) };
    }
    case "setup.updateSeat": {
      const target = state.seats.find((seat) => seat.id === action.seatId);
      if (target === void 0) {
        throw new SetupError(
          "invalid_action",
          isComputerSeatId(action.seatId) ? "that computer seat has just made way for a person or been removed" : "that seat is no longer in the game"
        );
      }
      const allowed = target.userId === null ? isGameMaster : target.userId === by;
      if (!allowed) {
        throw new SetupError(
          target.userId === null ? "not_game_master" : "invalid_action",
          target.userId === null ? "only the game master can change a computer seat" : "that is not your seat"
        );
      }
      const others = (target.userId === null ? state.seats : people).filter((seat) => seat.id !== target.id);
      const changed = {
        ...target,
        name: checkedText(action.name, limits.nameMaxLength, "name"),
        avatarId: figureNoOneElseHolds(action.avatarId, others, limits)
      };
      const replace = /* @__PURE__ */ __name((seats) => seats.map((seat) => seat.id === target.id ? changed : seat), "replace");
      return { state: withSeats(state, replace(people), replace(computers), limits) };
    }
    case "setup.setPlayerCount": {
      gameMasterOnly();
      const count = action.count;
      if (!Number.isInteger(count) || count < limits.playerCount.min || count > limits.playerCount.max) {
        throw new SetupError("invalid_action", `a game takes ${limits.playerCount.min} to ${limits.playerCount.max} players`);
      }
      if (count < people.length) throw new SetupError("invalid_action", `${people.length} seats are already taken`);
      return { state: withSeats({ ...state, playerCount: count }, people, computers, limits) };
    }
    case "setup.respondToJoin": {
      gameMasterOnly();
      const request = state.pending.find((pending2) => pending2.userId === action.userId);
      if (request === void 0) throw new SetupError("invalid_action", "there is no such request");
      const pending = state.pending.filter((other) => other.userId !== action.userId);
      if (!action.accept) return { state: { ...state, pending }, declined: action.userId };
      if (people.length >= state.playerCount) {
        throw new SetupError("game_full", "every seat is taken; raise the player count first");
      }
      const holder = people.find((seat) => seat.avatarId === request.requestedAvatarId);
      if (holder !== void 0) {
        throw new SetupError(
          "invalid_action",
          `${holder.name} has taken the figure ${request.requestedName} asked for; ${request.requestedName} has to pick another before you can accept them`
        );
      }
      const joined = {
        id: personSeatId(request.userId),
        seat: people.length + 1,
        playerId: playerIdForSeat(people.length + 1),
        userId: request.userId,
        name: request.requestedName,
        avatarId: request.requestedAvatarId,
        control: "human"
      };
      return { state: withSeats({ ...state, pending }, [...people, joined], computers, limits) };
    }
    case "setup.setSeed": {
      gameMasterOnly();
      return { state: { ...state, mapSeed: checkedText(action.seed, limits.seedMaxLength, "map seed") } };
    }
    case "setup.setThinkingTime": {
      gameMasterOnly();
      const seconds = action.seconds;
      const range = limits.thinkingSeconds;
      if (!Number.isInteger(seconds) || seconds < range.min || seconds > range.max) {
        throw new SetupError("invalid_action", `thinking time is whole seconds from ${range.min} to ${range.max}`);
      }
      return { state: { ...state, thinkingSeconds: seconds } };
    }
    case "setup.cancel": {
      gameMasterOnly();
      return { state: { ...state, phase: "cancelled", pending: [] } };
    }
    case "setup.start": {
      gameMasterOnly();
      return { state: { ...state, phase: "starting" } };
    }
  }
}
__name(applySetupAction, "applySetupAction");
function startGame(state, map) {
  if (state.phase !== "starting") throw new SetupError("invalid_action", "the game is not starting");
  if (map.seed !== state.mapSeed) throw new SetupError("invalid_action", "that map is for another seed");
  const game = createGameState({
    id: state.gameId,
    map,
    players: state.seats.map((seat) => ({
      id: seat.playerId,
      name: seat.name,
      avatarId: seat.avatarId,
      control: seat.control
    })),
    startingNode: startingNodeFor(map)
  });
  return { setup: { ...state, phase: "started", pending: [] }, game };
}
__name(startGame, "startGame");
function peopleOf(state) {
  return state.seats.filter((seat) => seat.userId !== null);
}
__name(peopleOf, "peopleOf");
function computersOf(state) {
  return state.seats.filter((seat) => seat.userId === null);
}
__name(computersOf, "computersOf");
function playerIdForSeat(seat) {
  return asPlayerId(`seat-${seat}`);
}
__name(playerIdForSeat, "playerIdForSeat");
function personSeatId(userId) {
  return `person:${userId}`;
}
__name(personSeatId, "personSeatId");
function isComputerSeatId(id) {
  return id.startsWith("computer:");
}
__name(isComputerSeatId, "isComputerSeatId");
function withSeats(state, people, computers, limits) {
  const room = state.playerCount - people.length;
  const kept = computers.slice(0, room);
  const seats = people.map((seat, index) => ({
    ...seat,
    seat: index + 1,
    playerId: playerIdForSeat(index + 1)
  }));
  for (const computer of kept) seats.push({ ...computer, userId: null, control: "ai" });
  let nextComputer = state.nextComputer;
  while (seats.length < state.playerCount) {
    seats.push({
      id: `computer:${nextComputer++}`,
      seat: 0,
      playerId: playerIdForSeat(0),
      userId: null,
      name: nextComputerName(seats),
      avatarId: freeFigure(seats, limits),
      control: "ai"
    });
  }
  const numbered = seats.map((seat, index) => ({ ...seat, seat: index + 1, playerId: playerIdForSeat(index + 1) }));
  return { ...state, seats: settleFigures(numbered, limits), nextComputer };
}
__name(withSeats, "withSeats");
function nextComputerName(seats) {
  const taken = new Set(seats.map((seat) => seat.name));
  for (let n = 1; ; n++) if (!taken.has(`Computer ${n}`)) return `Computer ${n}`;
}
__name(nextComputerName, "nextComputerName");
function firstFigure(limits) {
  const figure = limits.figures[0];
  if (figure === void 0) throw new RangeError("no figures to choose from");
  return figure;
}
__name(firstFigure, "firstFigure");
function freeFigure(seats, limits) {
  return limits.figures.find((id) => !seats.some((seat) => seat.avatarId === id)) ?? firstFigure(limits);
}
__name(freeFigure, "freeFigure");
function settleFigures(seats, limits) {
  const inUse = new Set(seats.filter((seat) => seat.userId !== null).map((seat) => seat.avatarId));
  const clashing = /* @__PURE__ */ new Set();
  for (const seat of seats) {
    if (seat.userId !== null) continue;
    if (inUse.has(seat.avatarId)) clashing.add(seat.id);
    else inUse.add(seat.avatarId);
  }
  return seats.map((seat) => {
    if (!clashing.has(seat.id)) return seat;
    const free = limits.figures.find((id) => !inUse.has(id));
    if (free === void 0) return seat;
    inUse.add(free);
    return { ...seat, avatarId: free };
  });
}
__name(settleFigures, "settleFigures");
function checkedText(value, maxLength, what) {
  if (typeof value !== "string") throw new SetupError("invalid_action", `the ${what} is missing`);
  const text = value.trim();
  if (text.length === 0) throw new SetupError("invalid_action", `the ${what} is empty`);
  if (text.length > maxLength) throw new SetupError("invalid_action", `the ${what} is longer than ${maxLength} characters`);
  return text;
}
__name(checkedText, "checkedText");
function checkedFigure(value, limits) {
  if (typeof value !== "string" || !limits.figures.includes(value)) {
    throw new SetupError("invalid_action", "there is no such figure");
  }
  return value;
}
__name(checkedFigure, "checkedFigure");
function figureNoOneElseHolds(value, others, limits) {
  const figure = checkedFigure(value, limits);
  const holder = others.find((seat) => seat.avatarId === figure);
  if (holder !== void 0) throw new SetupError("invalid_action", `${holder.name} holds that figure now; pick another`);
  return figure;
}
__name(figureNoOneElseHolds, "figureNoOneElseHolds");

// ../../packages/session/src/session.ts
var GameSession = class {
  constructor(gameId, ports, limits) {
    this.gameId = gameId;
    this.ports = ports;
    this.limits = limits;
  }
  gameId;
  ports;
  limits;
  static {
    __name(this, "GameSession");
  }
  /** Creates the game in setup. Called once, by whoever made the `gameId`. */
  async create(game) {
    if (await this.ports.games.loadSetup(this.gameId) !== null) {
      throw new SetupError("invalid_action", `game ${this.gameId} already exists`);
    }
    const setup = createSetup({ ...game, gameId: this.gameId, createdAt: this.ports.clock.now() }, this.limits);
    await this.ports.games.saveSetup(setup);
    await this.ports.directory.update(this.gameId, listingOf(setup));
    return setup;
  }
  /**
   * Someone opened the game: send them where it stands. A game master who
   * comes back while their Start is still waiting on the map is asked for it
   * again, so a reload in that moment cannot leave the game stuck.
   */
  async connected(user) {
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) {
      await this.ports.broadcaster.sendTo(user, notFound(this.gameId));
      return;
    }
    await this.ports.broadcaster.sendTo(user, { type: "setup.state", setup });
    const game = await this.ports.games.load(this.gameId);
    if (game !== null) await this.ports.broadcaster.sendTo(user, { type: "game.state", state: game });
    if (setup.phase === "starting" && user === setup.gameMaster) await this.requestMap(setup);
  }
  /**
   * Handle one client message. Returns once the resulting state is persisted
   * and broadcast. A refused message is answered with an `error` to its sender
   * alone and changes nothing.
   *
   * [SOURCE §4] GM-only messages (`gm.*`, `setup.*`) are authorised here and
   * nowhere else — the engine deliberately does not know who the GM is.
   * [SOURCE §3, chat] The GM is the game's creator and the role cannot be
   * transferred, so this check is against a value fixed at creation.
   */
  async handle(from, message) {
    try {
      await this.dispatch(from, message);
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      await this.ports.broadcaster.sendTo(from, { type: "error", code: error.code, message: error.message });
    }
  }
  async dispatch(from, message) {
    if (message.type === "lobby.create") {
      throw new SetupError("invalid_action", "games are created from the game list");
    }
    if (message.gameId !== this.gameId) throw new SetupError("game_not_found", "that message is for another game");
    const setup = await this.ports.games.loadSetup(this.gameId);
    if (setup === null) throw new SetupError("game_not_found", `there is no game ${this.gameId}`);
    switch (message.type) {
      case "setup.requestJoin":
      case "setup.updateRequest":
      case "setup.withdraw":
      case "setup.leave":
      case "setup.updateSeat":
      case "setup.setPlayerCount":
      case "setup.respondToJoin":
      case "setup.setSeed":
      case "setup.setThinkingTime":
      case "setup.cancel":
      case "setup.start": {
        const outcome = applySetupAction(setup, from, message, this.limits, this.ports.clock.now());
        await this.ports.games.saveSetup(outcome.state);
        await this.ports.broadcaster.broadcast(this.gameId, { type: "setup.state", setup: outcome.state });
        if (outcome.declined !== void 0) {
          await this.ports.broadcaster.sendTo(outcome.declined, { type: "setup.declined", gameId: this.gameId });
        }
        await this.ports.directory.update(this.gameId, listingOf(outcome.state));
        if (outcome.state.phase === "starting") await this.requestMap(outcome.state);
        return;
      }
      case "gm.mapGenerated": {
        if (from !== setup.gameMaster) throw new SetupError("not_game_master", "only the game master sends the map");
        if (!looksLikeAMap(message.map)) throw new SetupError("invalid_action", "that is not a map");
        const started = startGame(setup, message.map);
        await this.ports.games.save(started.game);
        await this.ports.games.saveSetup(started.setup);
        await this.ports.broadcaster.broadcast(this.gameId, { type: "setup.state", setup: started.setup });
        await this.ports.broadcaster.broadcast(this.gameId, { type: "game.state", state: started.game });
        await this.ports.directory.update(this.gameId, listingOf(started.setup));
        return;
      }
      default:
        throw new SetupError("invalid_action", "online turns are not playable yet");
    }
  }
  /**
   * [SOURCE §4] Runs an AI seat's turn. Called when a turn starts on an
   * AI-controlled seat, including a seat an AI took over after a resignation.
   *
   * [Q48] Computer seats' online turns are phase 7's. The move is thought on
   * the game master's machine (§12.1) and arrives as `gm.aiMove`, so this
   * awaits a reply rather than computing anything.
   */
  runAiTurn() {
    throw new NotImplementedError("GameSession.runAiTurn", "GDD.md \xA79, \xA77.3");
  }
  /**
   * [SOURCE §4] "A human player may resign at any time; an AI takes over so
   * play continues."
   * [SOURCE §4, chat] "Only the game master can hand control back to a human
   * after a resignation — not self-service by the player." So resignation flips
   * `control` to `'ai'` and sets `resigned`, and the *only* route back is a
   * `gm.setControl` message, which this method does not provide.
   */
  resign(_player) {
    throw new NotImplementedError("GameSession.resign", "GDD.md \xA77.3");
  }
  /**
   * [SOURCE §12.1, chat] The map is generated on the game master's machine.
   * [SOURCE §12.4, chat] With the GM gone nobody answers, and the game waits
   * in `starting` until they are back (`connected` asks again).
   */
  async requestMap(setup) {
    void GAME_MASTER_ABSENCE_BEHAVIOUR;
    await this.ports.broadcaster.sendTo(setup.gameMaster, {
      type: "gm.requestMapGeneration",
      gameId: this.gameId,
      seed: setup.mapSeed
    });
  }
};
function listingOf(setup) {
  if (setup.phase === "cancelled") return null;
  const people = setup.seats.filter((seat) => seat.userId !== null);
  return {
    gameId: setup.gameId,
    name: setup.name,
    gameMaster: setup.gameMaster,
    gameMasterName: setup.gameMasterName,
    phase: setup.phase === "started" ? "in_progress" : "setup",
    seatsTaken: people.length,
    seatsTotal: setup.playerCount,
    createdAt: setup.createdAt,
    members: people.map((seat) => seat.userId).filter((id) => id !== null)
  };
}
__name(listingOf, "listingOf");
function notFound(gameId) {
  return { type: "error", code: "game_not_found", message: `there is no game ${gameId}` };
}
__name(notFound, "notFound");
function looksLikeAMap(map) {
  if (typeof map !== "object" || map === null) return false;
  const candidate = map;
  return typeof candidate.seed === "string" && Array.isArray(candidate.graph?.nodes) && Array.isArray(candidate.pois) && candidate.poiByNode instanceof Map && typeof candidate.ruleset === "object";
}
__name(looksLikeAMap, "looksLikeAMap");

// src/adapters/durable-object.ts
function userSocketTag(userId) {
  return `user:${userId}`;
}
__name(userSocketTag, "userSocketTag");
var STATE_KEY = "state";
var SETUP_KEY = "setup";
function createDurableGameStore(gameId, storage) {
  const mine = /* @__PURE__ */ __name((id, what) => {
    if (id !== gameId) throw new RangeError(`${what} for ${id} saved to the object for ${gameId}`);
  }, "mine");
  return {
    load: /* @__PURE__ */ __name(async (id) => id === gameId ? await storage.get(STATE_KEY) ?? null : null, "load"),
    save: /* @__PURE__ */ __name(async (state) => {
      mine(state.id, "game");
      await storage.put(STATE_KEY, state);
    }, "save"),
    loadSetup: /* @__PURE__ */ __name(async (id) => id === gameId ? await storage.get(SETUP_KEY) ?? null : null, "loadSetup"),
    saveSetup: /* @__PURE__ */ __name(async (setup) => {
      mine(setup.gameId, "setup");
      await storage.put(SETUP_KEY, setup);
    }, "saveSetup")
  };
}
__name(createDurableGameStore, "createDurableGameStore");
function createSocketBroadcaster(gameId, sockets) {
  const sendAll = /* @__PURE__ */ __name((targets, message) => {
    const text = encodeMessage(message);
    for (const socket of targets) {
      try {
        socket.send(text);
      } catch {
      }
    }
  }, "sendAll");
  return {
    broadcast: /* @__PURE__ */ __name(async (id, message) => {
      if (id !== gameId) throw new RangeError(`broadcast for ${id} from the object for ${gameId}`);
      sendAll(sockets.getWebSockets(), message);
    }, "broadcast"),
    sendTo: /* @__PURE__ */ __name(async (userId, message) => {
      sendAll(sockets.getWebSockets(userSocketTag(userId)), message);
    }, "sendTo")
  };
}
__name(createSocketBroadcaster, "createSocketBroadcaster");
function createSqlAccountStore(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS logins (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER
  )`);
  const account = /* @__PURE__ */ __name((row) => row === void 0 ? null : {
    userId: asUserId(String(row["user_id"])),
    username: String(row["username"]),
    key: String(row["key"]),
    password: JSON.parse(String(row["password"])),
    createdAt: Number(row["created_at"])
  }, "account");
  return {
    accountByKey: /* @__PURE__ */ __name(async (key) => account(sql.exec("SELECT * FROM accounts WHERE key = ?", key).toArray()[0]), "accountByKey"),
    accountById: /* @__PURE__ */ __name(async (userId) => account(sql.exec("SELECT * FROM accounts WHERE user_id = ?", userId).toArray()[0]), "accountById"),
    insertAccount: /* @__PURE__ */ __name(async (record) => {
      if (sql.exec("SELECT 1 FROM accounts WHERE key = ?", record.key).toArray().length > 0) return false;
      sql.exec(
        "INSERT INTO accounts (user_id, username, key, password, created_at) VALUES (?, ?, ?, ?, ?)",
        record.userId,
        record.username,
        record.key,
        JSON.stringify(record.password),
        record.createdAt
      );
      return true;
    }, "insertAccount"),
    insertLogin: /* @__PURE__ */ __name(async (login) => {
      sql.exec(
        "INSERT INTO logins (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        login.tokenHash,
        login.userId,
        login.expiresAt
      );
    }, "insertLogin"),
    loginByTokenHash: /* @__PURE__ */ __name(async (tokenHash) => {
      const row = sql.exec("SELECT * FROM logins WHERE token_hash = ?", tokenHash).toArray()[0];
      return row === void 0 ? null : {
        tokenHash: String(row["token_hash"]),
        userId: asUserId(String(row["user_id"])),
        expiresAt: row["expires_at"] === null ? null : Number(row["expires_at"])
      };
    }, "loginByTokenHash"),
    deleteLogin: /* @__PURE__ */ __name(async (tokenHash) => {
      sql.exec("DELETE FROM logins WHERE token_hash = ?", tokenHash);
    }, "deleteLogin")
  };
}
__name(createSqlAccountStore, "createSqlAccountStore");

// src/adapters/memory.ts
var systemClock = { now: /* @__PURE__ */ __name(() => Date.now(), "now") };

// src/lobby.ts
import { DurableObject } from "cloudflare:workers";

// src/auth/password.ts
var PASSWORD_HASH_ITERATIONS = 1e5;
var SALT_BYTES = 16;
var HASH_BITS = 256;
var TOKEN_BYTES = 32;
async function hashPassword(password, iterations = PASSWORD_HASH_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { algorithm: "pbkdf2-sha256", iterations, salt: toBase64Url(salt), hash: toBase64Url(hash) };
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const hash = await derive(password, fromBase64Url(stored.salt), stored.iterations);
  return constantTimeEqual(hash, fromBase64Url(stored.hash));
}
__name(verifyPassword, "verifyPassword");
function newToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}
__name(newToken, "newToken");
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}
__name(derive, "derive");
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(toBase64Url, "toBase64Url");
function fromBase64Url(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
__name(fromBase64Url, "fromBase64Url");

// src/auth/accounts.ts
var AccountError = class extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
  reason;
  static {
    __name(this, "AccountError");
  }
  name = "AccountError";
};
var PasswordAccounts = class {
  constructor(store, rules, clock, newUserId = () => asUserId(crypto.randomUUID())) {
    this.store = store;
    this.rules = rules;
    this.clock = clock;
    this.newUserId = newUserId;
  }
  store;
  rules;
  clock;
  newUserId;
  static {
    __name(this, "PasswordAccounts");
  }
  method = "password";
  async register(credentials2) {
    const { username, password } = credentials2;
    const usernameProblem = this.rules.usernameProblem(username);
    if (usernameProblem !== null) throw new AccountError("username_invalid", usernameProblem);
    const passwordProblem = this.rules.passwordProblem(password);
    if (passwordProblem !== null) throw new AccountError("password_invalid", passwordProblem);
    const account = {
      userId: this.newUserId(),
      username,
      key: this.rules.canonicalUsername(username),
      password: await hashPassword(password),
      createdAt: this.clock.now()
    };
    if (!await this.store.insertAccount(account)) {
      throw new AccountError("username_taken", "That username is taken.");
    }
    return this.logIn(account);
  }
  async authenticate(credentials2) {
    const account = await this.store.accountByKey(this.rules.canonicalUsername(credentials2.username));
    if (account === null || !await verifyPassword(credentials2.password, account.password)) {
      throw new AccountError("wrong_credentials", "That username and password don\u2019t match an account.");
    }
    return this.logIn(account);
  }
  async verify(token) {
    const tokenHash = await hashToken(token);
    const login = await this.store.loginByTokenHash(tokenHash);
    if (login === null) return null;
    if (login.expiresAt !== null && login.expiresAt <= this.clock.now()) {
      await this.store.deleteLogin(tokenHash);
      return null;
    }
    const account = await this.store.accountById(login.userId);
    return account === null ? null : principalOf(account);
  }
  async logOut(token) {
    await this.store.deleteLogin(await hashToken(token));
  }
  async logIn(account) {
    const token = newToken();
    const lifetime = this.rules.loginLifetimeMs;
    await this.store.insertLogin({
      tokenHash: await hashToken(token),
      userId: account.userId,
      expiresAt: lifetime === null ? null : this.clock.now() + lifetime
    });
    return { principal: principalOf(account), token };
  }
};
function principalOf(account) {
  return { userId: account.userId, displayName: account.username };
}
__name(principalOf, "principalOf");
async function hashToken(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(hashToken, "hashToken");

// src/auth/rules.ts
var USERNAME = /^[\p{L}0-9_]{3,20}$/u;
var PASSWORD_MIN = 8;
var PASSWORD_MAX = 200;
var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
var ACCOUNT_RULES = {
  canonicalUsername: /* @__PURE__ */ __name((username) => username.toLowerCase(), "canonicalUsername"),
  usernameProblem: /* @__PURE__ */ __name((username) => USERNAME.test(username) ? null : "A username is 3 to 20 letters, digits or underscores.", "usernameProblem"),
  passwordProblem: /* @__PURE__ */ __name((password) => {
    if (password.length < PASSWORD_MIN) return `A password needs at least ${PASSWORD_MIN} characters.`;
    if (password.length > PASSWORD_MAX) return `A password can have at most ${PASSWORD_MAX} characters.`;
    return null;
  }, "passwordProblem"),
  loginLifetimeMs: THIRTY_DAYS_MS
};

// src/games.ts
function gameListFor(user, listings) {
  const newestFirst = [...listings].sort((a, b) => b.createdAt - a.createdAt);
  const mine = newestFirst.filter((listing) => listing.members.includes(user));
  const open = newestFirst.filter(
    (listing) => !listing.members.includes(user) && listing.phase === "setup" && listing.seatsTaken < listing.seatsTotal
  );
  return [...mine.map((listing) => summary(listing, true)), ...open.map((listing) => summary(listing, false))];
}
__name(gameListFor, "gameListFor");
function summary(listing, mine) {
  return {
    gameId: listing.gameId,
    name: listing.name,
    gameMaster: listing.gameMaster,
    gameMasterName: listing.gameMasterName,
    phase: listing.phase,
    seatsTaken: listing.seatsTaken,
    seatsTotal: listing.seatsTotal,
    createdAt: listing.createdAt,
    mine
  };
}
__name(summary, "summary");
function createSqlListingStore(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    listing TEXT NOT NULL
  )`);
  return {
    all: /* @__PURE__ */ __name(() => sql.exec("SELECT listing FROM games").toArray().map((row) => revive(JSON.parse(String(row["listing"])))), "all"),
    put: /* @__PURE__ */ __name((listing) => {
      sql.exec(
        "INSERT INTO games (game_id, listing) VALUES (?, ?) ON CONFLICT(game_id) DO UPDATE SET listing = excluded.listing",
        listing.gameId,
        JSON.stringify(listing)
      );
    }, "put"),
    remove: /* @__PURE__ */ __name((gameId) => {
      sql.exec("DELETE FROM games WHERE game_id = ?", gameId);
    }, "remove")
  };
}
__name(createSqlListingStore, "createSqlListingStore");
function revive(listing) {
  return { ...listing, gameId: asGameId(listing.gameId), members: listing.members.map((id) => asUserId(id)) };
}
__name(revive, "revive");

// src/lobby.ts
var Lobby = class extends DurableObject {
  static {
    __name(this, "Lobby");
  }
  accounts;
  listings;
  constructor(ctx, env) {
    super(ctx, env);
    this.accounts = new PasswordAccounts(createSqlAccountStore(ctx.storage.sql), ACCOUNT_RULES, systemClock);
    this.listings = createSqlListingStore(ctx.storage.sql);
  }
  register(username, password) {
    return this.account(() => this.accounts.register({ method: "password", username, password }));
  }
  logIn(username, password) {
    return this.account(() => this.accounts.authenticate({ method: "password", username, password }));
  }
  verify(token) {
    return this.accounts.verify(token);
  }
  logOut(token) {
    return this.accounts.logOut(token);
  }
  /** A game's row changed, or it left the list (`null`). */
  async updateGame(gameId, listing) {
    if (listing === null) this.listings.remove(gameId);
    else this.listings.put(listing);
    this.sendLists();
  }
  /** A game-list page's socket, already checked by the Worker. */
  async fetch(request) {
    const userId = request.headers.get(USER_HEADER);
    if (request.headers.get("Upgrade") !== "websocket" || userId === null) {
      return new Response("expected a game-list socket", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [userSocketTag(asUserId(userId))]);
    const who = { userId: asUserId(userId), displayName: request.headers.get(NAME_HEADER) ?? "" };
    server.serializeAttachment(who);
    server.send(encodeMessage(this.listFor(who.userId)));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    const who = ws.deserializeAttachment();
    const reply = /* @__PURE__ */ __name((message2) => ws.send(encodeMessage(message2)), "reply");
    let message;
    try {
      message = decodeClientMessage(typeof data === "string" ? data : "");
    } catch {
      reply({ type: "error", code: "invalid_action", message: "that message could not be read" });
      return;
    }
    if (message.type !== "lobby.create") {
      reply({ type: "error", code: "invalid_action", message: "the game list only creates games" });
      return;
    }
    const gameId = newGameId();
    let created;
    try {
      created = await roomOf(this.env, gameId).create(gameId, {
        name: message.name,
        gameMaster: { userId: who.userId, displayName: who.displayName },
        mapSeed: friendlySeed(cryptoRandom)
      });
    } catch (error) {
      console.error(error);
      created = { ok: false, message: "the game could not be created; try again" };
    }
    reply(created.ok ? { type: "lobby.created", gameId } : { type: "error", code: "invalid_action", message: created.message });
  }
  async webSocketClose(ws, code, reason) {
    closeQuietly(ws, code, reason);
  }
  listFor(userId) {
    return { type: "lobby.games", games: gameListFor(userId, this.listings.all()) };
  }
  sendLists() {
    const all = this.listings.all();
    for (const ws of this.ctx.getWebSockets()) {
      const who = ws.deserializeAttachment();
      try {
        ws.send(encodeMessage({ type: "lobby.games", games: gameListFor(who.userId, all) }));
      } catch {
      }
    }
  }
  async account(attempt) {
    try {
      const { principal, token } = await attempt();
      return { ok: true, login: { token, user: principal } };
    } catch (error) {
      if (error instanceof AccountError) return { ok: false, failure: { error: error.message, reason: error.reason } };
      throw error;
    }
  }
};
function cryptoRandom() {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;
}
__name(cryptoRandom, "cryptoRandom");
function newGameId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return asGameId(Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(""));
}
__name(newGameId, "newGameId");
function closeQuietly(ws, code, reason) {
  try {
    ws.close(code === 1005 ? 1e3 : code, reason);
  } catch {
  }
}
__name(closeQuietly, "closeQuietly");

// ../../Art/player_avatars_atlas.json
var player_avatars_atlas_default = {
  sheet: "player_avatars_sheet.png",
  cell_width: 617,
  cell_height: 698,
  sprites: [
    {
      id: "player_avatars_01",
      x: 0,
      y: 0,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        158,
        113,
        593,
        615
      ]
    },
    {
      id: "player_avatars_02",
      x: 617,
      y: 0,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        1174,
        93,
        515,
        642
      ]
    },
    {
      id: "player_avatars_03",
      x: 1234,
      y: 0,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        2103,
        93,
        413,
        633
      ]
    },
    {
      id: "player_avatars_04",
      x: 1851,
      y: 0,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        170,
        804,
        553,
        674
      ]
    },
    {
      id: "player_avatars_05",
      x: 0,
      y: 698,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        2186,
        809,
        356,
        659
      ]
    },
    {
      id: "player_avatars_06",
      x: 617,
      y: 698,
      width: 617,
      height: 698,
      anchor: {
        x: 308,
        y: 686
      },
      source_box_in_original: [
        1260,
        913,
        361,
        542
      ]
    }
  ]
};

// src/limits.ts
var SETUP_LIMITS = setupLimitsFor(
  DEFAULT_RULESET,
  player_avatars_atlas_default.sprites.map((sprite) => sprite.id)
);

// src/room.ts
var GAME_ID_KEY = "gameId";
var GameRoom = class extends DurableObject2 {
  static {
    __name(this, "GameRoom");
  }
  queue = Promise.resolve();
  /** Called by the lobby, once, right after it names the game. */
  async create(gameId, game) {
    return this.inTurn(async () => {
      if (await this.ctx.storage.get(GAME_ID_KEY) !== void 0) return { ok: false, message: "that game exists already" };
      await this.ctx.storage.put(GAME_ID_KEY, gameId);
      try {
        await this.session(gameId).create(game);
        return { ok: true };
      } catch (error) {
        await this.ctx.storage.delete(GAME_ID_KEY);
        if (error instanceof SetupError) return { ok: false, message: error.message };
        throw error;
      }
    });
  }
  /** A socket for this game, from the Worker, which has checked the login. */
  async fetch(request) {
    const userId = request.headers.get(USER_HEADER);
    if (request.headers.get("Upgrade") !== "websocket" || userId === null) {
      return new Response("expected a game socket", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const who = { userId: asUserId(userId) };
    this.ctx.acceptWebSocket(server, [userSocketTag(who.userId)]);
    server.serializeAttachment(who);
    void this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) {
        server.send(encodeMessage({ type: "error", code: "game_not_found", message: "there is no such game" }));
        return;
      }
      await this.session(gameId).connected(who.userId);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    const who = ws.deserializeAttachment();
    await this.inTurn(async () => {
      const gameId = await this.gameId();
      if (gameId === null) return;
      let message;
      try {
        message = decodeClientMessage(typeof data === "string" ? data : "");
      } catch (error) {
        if (!(error instanceof WireError)) throw error;
        ws.send(encodeMessage({ type: "error", code: "invalid_action", message: "that message could not be read" }));
        return;
      }
      try {
        await this.session(gameId).handle(who.userId, message);
      } catch (error) {
        console.error(error);
        ws.send(encodeMessage({ type: "error", code: "invalid_action", message: "something went wrong on the server; try again" }));
      }
    });
  }
  async webSocketClose(ws, code, reason) {
    closeQuietly(ws, code, reason);
  }
  async gameId() {
    const id = await this.ctx.storage.get(GAME_ID_KEY);
    return id === void 0 ? null : asGameId(id);
  }
  session(gameId) {
    return new GameSession(
      gameId,
      {
        games: createDurableGameStore(gameId, this.ctx.storage),
        broadcaster: createSocketBroadcaster(gameId, this.ctx),
        clock: systemClock,
        directory: { update: /* @__PURE__ */ __name((id, listing) => lobbyOf(this.env).updateGame(id, listing), "update") }
      },
      SETUP_LIMITS
    );
  }
  /** Runs `work` after everything queued before it, whatever happened to that. */
  inTurn(work) {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
};

// src/worker.ts
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, url, env);
    } catch (error) {
      console.error(error);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  }
};
async function api(request, url, env) {
  const lobby = lobbyOf(env);
  const path = url.pathname;
  if (request.method === "POST" && (path === "/api/register" || path === "/api/login")) {
    const body = await credentials(request);
    if (body === null) return json(failure("Send a username and a password."), 400);
    const outcome = path === "/api/register" ? await lobby.register(body.username, body.password) : await lobby.logIn(body.username, body.password);
    if (outcome.ok) return json(outcome.login, 200);
    return json(outcome.failure, outcome.failure.reason === "wrong_credentials" ? 401 : 400);
  }
  if (request.method === "POST" && path === "/api/logout") {
    const token = bearer(request);
    if (token !== null) await lobby.logOut(token);
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && path === "/api/me") {
    const user = await signedIn(request, env);
    return user === null ? json(failure("You are not logged in."), 401) : json(user, 200);
  }
  const game = /^\/api\/games\/([a-z0-9]{4,32})$/.exec(path);
  if (request.method === "GET" && (path === "/api/lobby" || game !== null)) {
    if (request.headers.get("Upgrade") !== "websocket") return json(failure("This address takes a WebSocket."), 426);
    const user = await signedIn(request, env);
    if (user === null) return json(failure("You are not logged in."), 401);
    const forwarded = new Request(url.toString(), {
      headers: {
        Upgrade: "websocket",
        [USER_HEADER]: user.userId,
        [NAME_HEADER]: user.displayName
      }
    });
    const gameId = game?.[1] === void 0 ? null : asGameId(game[1]);
    return gameId === null ? lobby.fetch(forwarded) : roomOf(env, gameId).fetch(forwarded);
  }
  return json(failure("There is nothing at this address."), 404);
}
__name(api, "api");
async function signedIn(request, env) {
  const token = bearer(request) ?? new URL(request.url).searchParams.get("token");
  return token === null || token.length === 0 ? null : lobbyOf(env).verify(token);
}
__name(signedIn, "signedIn");
function bearer(request) {
  const header = request.headers.get("Authorization");
  return header !== null && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}
__name(bearer, "bearer");
async function credentials(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { username, password } = body;
  return typeof username === "string" && typeof password === "string" ? { username, password } : null;
}
__name(credentials, "credentials");
function failure(error) {
  return { error, reason: "bad_request" };
}
__name(failure, "failure");
function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
__name(json, "json");

// ../../node_modules/.pnpm/wrangler@4.138.0_@cloudflare+workers-types@5.20260924.1_@types+node@26.6.2/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../node_modules/.pnpm/wrangler@4.138.0_@cloudflare+workers-types@5.20260924.1_@types+node@26.6.2/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-lX6IF2/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../node_modules/.pnpm/wrangler@4.138.0_@cloudflare+workers-types@5.20260924.1_@types+node@26.6.2/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-lX6IF2/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GameRoom,
  Lobby,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
