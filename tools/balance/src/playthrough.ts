import { startingStaminaForSeat, type Ruleset } from '@adventure/config';
import {
  applyAction,
  createDiceSource,
  createGameState,
  createRng,
  chooseStartingNode,
  dijkstra,
  previewPath,
  poiAt,
  shortestPath,
  asGameId,
  asPlayerId,
  type GameEvent,
  type GameMap,
  type GameState,
  type NodeId,
  type PlayerId,
  type PlayerStats,
  type Seed,
  type TurnAction,
} from '@adventure/core';
import { generateAndReport } from './index.ts';

/**
 * A whole game, played headlessly through `applyAction`.
 *
 * This is the harness's end-to-end check on the rules engine (phase 2): every
 * turn goes through the one writer, on a real generated map, and the run either
 * reaches §1's win condition or reports why it could not. It is deliberately
 * **not** an AI — §9's MCTS player is phase 5 and lives in `@adventure/ai`.
 * The driver below makes the dumbest defensible decision a player could make,
 * so that what the transcript shows is the rules working and not a policy
 * being clever.
 *
 * The policy, in full:
 *
 *  - target the nearest POI (weighted terrain cost, the one metric) whose
 *    reward is unclaimed and which this player could in principle take — a
 *    guard the player cannot beat even on the die's best face is skipped, since
 *    attacking it is an infinite loop rather than a decision;
 *  - walk the shortest path to it and let §7 truncate the walk at whatever this
 *    turn affords;
 *  - standing on the target already (a guard survived last turn) means a
 *    zero-length move, which §8 makes another attempt;
 *  - rest when this turn cannot afford even the first step, or when no target
 *    is left.
 */

export type PlaythroughEnd = 'victory' | 'stalemate' | 'turn_cap';

export interface PlaythroughOptions {
  readonly seed: Seed;
  /** Kept apart from the map seed, as the server's die stream is (§8). */
  readonly diceSeed: string;
  readonly playerCount: number;
  /** A game that has not ended by here is reported rather than run for ever. */
  readonly maxTurns: number;
}

/** One turn as it was played, for the transcript. */
export interface PlayedTurn {
  readonly number: number;
  readonly seat: number;
  readonly name: string;
  readonly events: readonly GameEvent[];
  /** The acting player's stats as the turn began, so a roll can be read back. */
  readonly statsBefore: PlayerStats;
  readonly staminaAfter: number;
  readonly goldAfter: number;
}

export interface Playthrough {
  readonly map: GameMap;
  readonly options: PlaythroughOptions;
  readonly startingNode: NodeId;
  readonly finalState: GameState;
  readonly turns: readonly PlayedTurn[];
  readonly endedBy: PlaythroughEnd;
}

export function playGame(options: PlaythroughOptions, ruleset: Ruleset): Playthrough {
  const { map } = generateAndReport(options.seed, ruleset);
  const startingNode = chooseStartingNode(map, createRng(map.seed).fork('starting-node'));
  const dice = createDiceSource(createRng(options.diceSeed), ruleset.config);

  let state = createGameState({
    id: asGameId(`playthrough-${options.seed}`),
    map,
    players: Array.from({ length: options.playerCount }, (_unused, index) => ({
      id: asPlayerId(`p${index + 1}`),
      name: `p${index + 1}`,
      avatarId: `avatar-${index + 1}`,
      control: 'ai' as const,
    })),
    startingNode,
  });

  const turns: PlayedTurn[] = [];
  let endedBy: PlaythroughEnd = 'turn_cap';
  /** Consecutive seats that found nothing they could ever take. */
  let idleSeats = 0;

  while (turns.length < options.maxTurns) {
    if (state.status === 'finished') {
      endedBy = 'victory';
      break;
    }

    const seat = state.turn.activeSeat;
    const player = state.players[seat - 1];
    if (player === undefined) throw new Error(`no player in seat ${seat}`);

    // A player with nothing it could ever take still has to take a turn, and
    // resting is what §7 offers. Only once *every* seat in one full cycle has
    // nothing left is the game stuck: no claim can happen, so §1's win
    // condition can never be reached and playing on would only burn turns.
    const chosen = chooseAction(state, player.id, ruleset);
    const action = chosen ?? { kind: 'rest' as const, player: player.id };
    idleSeats = chosen === null ? idleSeats + 1 : 0;
    if (idleSeats >= state.players.length) {
      endedBy = 'stalemate';
      break;
    }

    const turnNumber = state.turn.number;
    const outcome = applyAction(state, action, dice);
    state = outcome.state;

    const after = state.players[seat - 1];
    turns.push({
      number: turnNumber,
      seat,
      name: player.name,
      events: outcome.events,
      statsBefore: player.stats,
      staminaAfter: after?.stats.stamina ?? 0,
      goldAfter: after?.stats.gold ?? 0,
    });
  }

  if (state.status === 'finished') endedBy = 'victory';

  return { map, options, startingNode, finalState: state, turns, endedBy };
}

/** `null` when this player has nothing left it could ever take. */
function chooseAction(state: GameState, playerId: PlayerId, ruleset: Ruleset): TurnAction | null {
  const player = state.players.find((current) => current.id === playerId);
  if (player === undefined) throw new Error(`no such player ${playerId}`);

  const target = nearestViableTarget(state, playerId, ruleset);
  if (target === null) return null;
  if (target === player.position) return { kind: 'move', player: playerId, path: [] };

  const path = shortestPath(state.map.graph, player.position, target, ruleset.config);
  // §2.1 step 8 rejects a disconnected map, so every POI is reachable.
  if (path === null) throw new Error(`node ${target} is unreachable from ${player.position}`);

  const preview = previewPath(
    state.map.graph,
    player.position,
    path,
    state.turn.allowance,
    player.stats.stamina,
    ruleset.config,
  );
  // Nothing affordable this turn, so recover instead of standing still: grey is
  // a statement about this turn only (§7.1).
  if (preview.reachableStepCount === 0) return { kind: 'rest', player: playerId };

  return { kind: 'move', player: playerId, path };
}

function nearestViableTarget(state: GameState, playerId: PlayerId, ruleset: Ruleset): NodeId | null {
  const player = state.players.find((current) => current.id === playerId);
  if (player === undefined) throw new Error(`no such player ${playerId}`);

  const { costs } = dijkstra(state.map.graph, player.position, ruleset.config);
  const best = { node: null as NodeId | null, cost: Number.POSITIVE_INFINITY };

  for (const [node, index] of state.map.poiByNode) {
    if (state.poiRuntime[index]?.claimedBy !== null) continue;
    if (!couldTake(state, node, playerId, ruleset)) continue;
    const cost = costs[node] ?? Number.POSITIVE_INFINITY;
    // Ties break on node id, as the one shortest-path search does, so a
    // playthrough is a function of its two seeds and nothing else.
    if (cost < best.cost) {
      best.node = node;
      best.cost = cost;
    }
  }
  return best.node;
}

/**
 * Whether this player could take the POI at all — §8's roll is
 * `roll + skill > strength`, so a guard beyond `skill + the die's best face` is
 * not a hard target, it is an impossible one.
 */
function couldTake(state: GameState, node: NodeId, playerId: PlayerId, ruleset: Ruleset): boolean {
  const poi = poiAt(state.map, node);
  if (poi === undefined) return false;
  if (poi.guard === null) return true;

  const player = state.players.find((current) => current.id === playerId);
  if (player === undefined) return false;

  const { count, sides } = ruleset.config.combat.GUARD_DIE;
  const skill = player.stats[poi.guard.type];
  return count * sides + skill > poi.guard.strength;
}

/* -------------------------------------------------------------------------- */
/*  The transcript                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The playthrough as text, one line per turn — the same "one record per line"
 * shape as `formatMapSummary`, so a golden diff stays legible in a review.
 */
export function formatPlaythrough(run: Playthrough): string {
  const lines: string[] = [];
  const goldTotal = run.map.pois.reduce(
    (sum, poi) => sum + (poi.reward.kind === 'gold' ? poi.reward.units : 0),
    0,
  );

  lines.push(`# ${run.options.seed} — ${run.options.playerCount}-player playthrough. See golden/README.md before updating.`);
  lines.push(
    `meta dice_seed=${run.options.diceSeed} start_node=${run.startingNode} pois=${run.map.pois.length} gold_units=${goldTotal}`,
  );
  for (const player of run.finalState.players) {
    lines.push(`player ${player.name} seat=${player.seat} stamina=${startingStaminaForSeat(player.seat, run.map.ruleset)}`);
  }

  for (const turn of run.turns) {
    lines.push(`turn ${String(turn.number).padStart(3, ' ')} ${turn.name} ${describe(turn, run.map)}`);
  }

  lines.push(`ended ${run.endedBy} after ${run.turns.length} turns`);
  for (const player of run.finalState.players) {
    const skills = `pm=${player.stats.plains_move} fm=${player.stats.forest_move} mm=${player.stats.mountain_move} f=${player.stats.fighting} m=${player.stats.magic}`;
    lines.push(`final ${player.name} gold=${player.stats.gold} stamina=${player.stats.stamina} ${skills}`);
  }
  lines.push(`winners ${run.finalState.winners.length === 0 ? 'none' : run.finalState.winners.join(' ')}`);

  return `${lines.join('\n')}\n`;
}

function describe(turn: PlayedTurn, map: GameMap): string {
  const parts: string[] = [];
  for (const event of turn.events) {
    switch (event.type) {
      case 'moved': {
        const { resolution } = event;
        parts.push(
          `move ${resolution.walked.length}/${resolution.walked.length + resolution.remainder.length} -> ${resolution.to} stam-${resolution.staminaSpent}`,
        );
        break;
      }
      case 'rested':
        parts.push(`rest stam+${event.staminaGained}`);
        break;
      case 'interacted': {
        const { resolution } = event;
        if (resolution.reward === null) break;
        const guard = poiAt(map, resolution.node)?.guard ?? null;
        // §8's comparison, written out so the transcript shows the rule and
        // not just its verdict: roll + matching skill > guard strength.
        const attempt =
          resolution.roll === null || guard === null || resolution.skillUsed === null
            ? 'unguarded'
            : `${guard.type}:${guard.strength} roll ${resolution.roll.value}+${turn.statsBefore[resolution.skillUsed]}`;
        parts.push(
          `poi ${resolution.node} ${resolution.reward.kind}x${resolution.reward.units} ${attempt} ${resolution.claimed ? 'TAKEN' : 'kept'}`,
        );
        break;
      }
      case 'game_won':
        parts.push(`WON ${event.winners.join(' ')}`);
        break;
      default:
        break;
    }
  }
  parts.push(`| stam=${turn.staminaAfter} gold=${turn.goldAfter}`);
  return parts.join(' ');
}
