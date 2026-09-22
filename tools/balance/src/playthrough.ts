import { startingStaminaForSeat, type Ruleset, type Terrain } from '@adventure/config';
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
  type InteractionResolution,
  type MovementResolution,
  type MovementAllowance,
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

/**
 * One turn as it was played.
 *
 * Everything a reader needs to check the turn against the rules by hand is
 * recorded as it stood *before* the turn — where the player was, what allowance
 * §7 had just refreshed for them, and the stat block a guard roll was added to.
 * The transcript then shows the turn's arithmetic against those, and the
 * standings after it.
 */
export interface PlayedTurn {
  readonly number: number;
  readonly seat: number;
  readonly name: string;
  readonly events: readonly GameEvent[];
  readonly positionBefore: NodeId;
  /** The free steps per terrain this turn started with (§7). */
  readonly allowanceBefore: MovementAllowance;
  /** The acting player's stats as the turn began, so a roll can be read back. */
  readonly statsBefore: PlayerStats;
  /** Every player's stats once the turn resolved, in seat order. */
  readonly standings: readonly PlayerStanding[];
  /**
   * Where the driver was sending this player and by which route, or `null`
   * when there was nothing left it could take. The engine never sees this —
   * a move action carries only its path — so it is recorded here, because a
   * walk cannot be judged without knowing where it was going.
   */
  readonly heading: Heading | null;
}

export interface Heading {
  readonly target: NodeId;
  /** The whole shortest path from where the turn began, target last. */
  readonly route: readonly NodeId[];
}

export interface PlayerStanding {
  readonly name: string;
  readonly stats: PlayerStats;
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
    const action = chosen?.action ?? { kind: 'rest' as const, player: player.id };
    idleSeats = chosen === null ? idleSeats + 1 : 0;
    if (idleSeats >= state.players.length) {
      endedBy = 'stalemate';
      break;
    }

    const turnNumber = state.turn.number;
    const allowanceBefore = state.turn.allowance;
    const outcome = applyAction(state, action, dice);
    state = outcome.state;

    turns.push({
      number: turnNumber,
      seat,
      name: player.name,
      events: outcome.events,
      positionBefore: player.position,
      allowanceBefore,
      statsBefore: player.stats,
      standings: state.players.map((current) => ({ name: current.name, stats: current.stats })),
      heading: chosen?.heading ?? null,
    });
  }

  if (state.status === 'finished') endedBy = 'victory';

  return { map, options, startingNode, finalState: state, turns, endedBy };
}

/** `null` when this player has nothing left it could ever take. */
function chooseAction(
  state: GameState,
  playerId: PlayerId,
  ruleset: Ruleset,
): { action: TurnAction; heading: Heading } | null {
  const player = state.players.find((current) => current.id === playerId);
  if (player === undefined) throw new Error(`no such player ${playerId}`);

  const target = nearestViableTarget(state, playerId, ruleset);
  if (target === null) return null;
  if (target === player.position) {
    return { action: { kind: 'move', player: playerId, path: [] }, heading: { target, route: [] } };
  }

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
  const heading = { target, route: path };
  if (preview.reachableStepCount === 0) return { action: { kind: 'rest', player: playerId }, heading };

  return { action: { kind: 'move', player: playerId, path }, heading };
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

const TERRAIN_SKILL: Record<Terrain, keyof PlayerStats> = {
  plains: 'plains_move',
  forest: 'forest_move',
  mountain: 'mountain_move',
};

/**
 * The playthrough as text, written so that **every number in it can be checked
 * by hand** against `GDD.md` §7 and §8 and the map.
 *
 * That is the whole design brief. A turn prints where the player stood, the
 * allowance §7 had just refreshed for them, then one line per step naming the
 * node entered, its terrain, and which of the two things paid for it — a moving
 * skill (with the allowance counting down) or stamina (with the §11 cost and
 * what is left). A guard prints the roll, the skill added to it and the
 * strength it had to beat. Every player's stats follow, so a reader never has
 * to carry a number forward in their head.
 *
 * Node ids are the ids on the diagnostic map (`pnpm map <seed>`), which labels
 * every node — the transcript and the drawing are meant to be read together.
 *
 * The per-step accounting comes from the engine's own `previewPath`, not from a
 * second implementation of §7 here: it is the same function family as
 * `resolveMovement`, so what this file shows is what the engine did, and a
 * transcript that disagreed with the moves would be a bug in the engine rather
 * than in the log.
 */
export function formatPlaythrough(run: Playthrough): string {
  const lines: string[] = [];
  const config = run.map.ruleset.config;
  const goldTotal = run.map.pois.reduce(
    (sum, poi) => sum + (poi.reward.kind === 'gold' ? poi.reward.units : 0),
    0,
  );

  lines.push(`# ${run.options.seed} — ${run.options.playerCount}-player playthrough. See golden/README.md before updating.`);
  lines.push('#');
  lines.push('# Node ids are the ids drawn on the diagnostic map for this seed (pnpm map ' + run.options.seed + ').');
  lines.push('# Every step says which terrain was entered and what paid for it: a moving skill');
  lines.push('# (§7 allowance, counted down) or stamina (§11 STAMINA_COST: plains 1, forest 2, mountain 3).');
  lines.push('# "plan" is where the test driver sent the player: the nearest POI (by step cost) still');
  lines.push('# unclaimed that they could beat on the best roll. It is a deliberately simple rule, not the AI.');
  lines.push('# Free steps only pay for their own terrain. A walk that ends short names the step it could');
  lines.push('# not pay for; the rest of the path waits for next turn (§7).');
  lines.push('# A guarded POI says roll + skill vs guard strength; §8 needs strictly greater.');
  lines.push('#');
  lines.push(
    `meta dice_seed=${run.options.diceSeed} start_node=${run.startingNode} nodes=${run.map.graph.nodes.length} pois=${run.map.pois.length} gold_units=${goldTotal}`,
  );
  lines.push(
    `meta rest_stamina_gain=${config.movement.REST_STAMINA_GAIN} guard_die=${config.combat.GUARD_DIE.count}d${config.combat.GUARD_DIE.sides}`,
  );
  for (const player of run.finalState.players) {
    lines.push(
      `player ${player.name} seat=${player.seat} starting_stamina=${startingStaminaForSeat(player.seat, run.map.ruleset)} starting_node=${run.startingNode}`,
    );
  }

  for (const turn of run.turns) lines.push('', ...turnLines(turn, run));

  lines.push('');
  lines.push(`ended ${run.endedBy} after ${run.turns.length} turns`);
  for (const player of run.finalState.players) lines.push(`final ${statLine(player.name, player.stats)}`);
  lines.push(`winners ${run.finalState.winners.length === 0 ? 'none' : run.finalState.winners.join(' ')}`);

  return `${lines.join('\n')}\n`;
}

function turnLines(turn: PlayedTurn, run: Playthrough): string[] {
  const { allowanceBefore: allowance, statsBefore: stats } = turn;
  const lines: string[] = [
    `turn ${String(turn.number).padStart(3, ' ')}  ${turn.name} (seat ${turn.seat})  at node ${turn.positionBefore}` +
      `  allowance plains ${allowance.plains} / forest ${allowance.forest} / mountain ${allowance.mountain}` +
      `  stamina ${stats.stamina}`,
    ...headingLines(turn, run),
  ];

  for (const event of turn.events) {
    switch (event.type) {
      case 'moved':
        lines.push(...moveLines(event.resolution, turn, run));
        break;
      case 'rested':
        lines.push(`  rest    +${event.staminaGained} stamina (REST_STAMINA_GAIN), no move and no interaction`);
        break;
      case 'interacted':
        lines.push(...interactionLines(event.resolution, turn, run));
        break;
      case 'game_won':
        lines.push(`  won     ${event.winners.join(' ')} — lead exceeds the gold still on the map (§1)`);
        break;
      default:
        break;
    }
  }

  for (const standing of turn.standings) lines.push(`  ${statLine(standing.name, standing.stats)}`);
  return lines;
}

/**
 * Where the player was going, before what happened on the way.
 *
 * The driver's rule is the nearest POI (by §11 step cost) that is unclaimed and
 * that this player could beat on the die's best face, so naming the target
 * also says why every nearer POI was passed over: it was already taken or out
 * of reach. A rest with a target says which step could not be paid for.
 */
function headingLines(turn: PlayedTurn, run: Playthrough): string[] {
  const { heading } = turn;
  if (heading === null) return ['  plan    nothing left on the map this player could take, so rests'];

  const what = describePoi(run, heading.target);
  if (heading.route.length === 0) {
    return [`  plan    already on node ${heading.target} (${what}), attacks it again`];
  }
  const lines = [
    `  plan    heading for node ${heading.target} (${what}), the nearest POI ${turn.name} could take`,
    `          route ${[turn.positionBefore, ...heading.route].join(' -> ')}`,
  ];
  if (turn.events.some((event) => event.type === 'rested')) {
    lines.push(
      `          can't pay the first step, ${blockedStep(turn.positionBefore, heading.route, turn, run, turn.allowanceBefore, turn.statsBefore.stamina)}, so rests`,
    );
  }
  return lines;
}

function describePoi(run: Playthrough, node: NodeId): string {
  const poi = poiAt(run.map, node);
  if (poi === undefined) throw new Error(`no POI at node ${node}`);
  const reward = `${poi.reward.kind} x${poi.reward.units}`;
  return poi.guard === null ? `${reward}, unguarded` : `${reward}, guarded ${poi.guard.type} ${poi.guard.strength}`;
}

/**
 * One line per step walked, from the engine's own accounting.
 *
 * The allowance is counted down here only to *print* it; which steps were free
 * is `previewPath`'s answer, not this function's.
 */
function moveLines(resolution: MovementResolution, turn: PlayedTurn, run: Playthrough): string[] {
  const config = run.map.ruleset.config;
  if (resolution.walked.length === 0) {
    const planned = resolution.remainder.length;
    return [
      planned === 0
        ? `  move    stayed on node ${resolution.from} (empty path — §8's second attempt at the same guard)`
        : `  move    no step affordable this turn: first step ${blockedStep(resolution.from, resolution.remainder, turn, run, turn.allowanceBefore, turn.statsBefore.stamina)}; ${planned} still planned`,
    ];
  }

  const preview = previewPath(
    run.map.graph,
    resolution.from,
    resolution.walked,
    turn.allowanceBefore,
    turn.statsBefore.stamina,
    config,
  );

  const left: Record<Terrain, number> = { ...turn.allowanceBefore };
  let stamina = turn.statsBefore.stamina;
  let from = resolution.from;
  const lines: string[] = [];

  for (const step of preview.steps) {
    const terrain = terrainOf(run, step.node);
    const skill = TERRAIN_SKILL[terrain];
    const where = `${String(from).padStart(3, ' ')} -> ${String(step.node).padStart(3, ' ')}  ${terrain.padEnd(8)}`;
    if (step.color === 'free') {
      left[terrain] -= 1;
      lines.push(`  step    ${where} free (${skill} allowance ${left[terrain] + 1} -> ${left[terrain]})`);
    } else {
      stamina -= step.staminaCost;
      const why =
        turn.statsBefore[skill] === 0
          ? `${skill} 0, no free steps`
          : `${skill} ${turn.statsBefore[skill]}, allowance already spent`;
      lines.push(`  step    ${where} ${step.staminaCost} stamina (${why}), ${stamina} left`);
    }
    from = step.node;
  }

  if (resolution.remainder.length > 0) {
    lines.push(
      `  move    stopped at node ${resolution.to}: next step ${blockedStep(resolution.to, resolution.remainder, turn, run, left, stamina)}`,
      `          ${resolution.remainder.length} step${resolution.remainder.length === 1 ? '' : 's'} saved as next turn's planned path`,
    );
  }
  return lines;
}

/**
 * Why a walk ended short: the step it could not pay for.
 *
 * §7's walk has exactly one reason to stop early — the next step is not free
 * (its terrain's allowance is spent or was never there) and costs more stamina
 * than is left — so naming that step, its terrain and the two numbers is the
 * whole explanation. Allowance left in *other* terrains does not help, and the
 * line says which skill would have.
 */
function blockedStep(
  at: NodeId,
  remainder: readonly NodeId[],
  turn: PlayedTurn,
  run: Playthrough,
  allowanceLeft: MovementAllowance,
  staminaLeft: number,
): string {
  const next = remainder[0];
  if (next === undefined) throw new Error('a stopped walk has a next step');
  const terrain = terrainOf(run, next);
  const skill = TERRAIN_SKILL[terrain];
  const cost = run.map.ruleset.config.movement.STAMINA_COST[terrain];
  // Blocked means not free, so this terrain's allowance is at 0 by now.
  if (allowanceLeft[terrain] !== 0) throw new Error(`step to ${next} was free yet the walk stopped`);
  const level = turn.statsBefore[skill];
  const free = level === 0 ? `${skill} 0` : `${skill} ${level}, all ${level} free steps spent`;
  return `${at} -> ${next} ${terrain} needs ${cost} stamina (${free}), ${staminaLeft} left`;
}

function interactionLines(
  resolution: InteractionResolution,
  turn: PlayedTurn,
  run: Playthrough,
): string[] {
  if (resolution.reward === null) return [];
  const { kind, units } = resolution.reward;
  const guard = poiAt(run.map, resolution.node)?.guard ?? null;
  const what = `node ${resolution.node} holds ${kind} x${units}`;

  if (resolution.roll === null || guard === null || resolution.skillUsed === null) {
    return [`  poi     ${what}, unguarded — taken (§8)`];
  }

  const skill = turn.statsBefore[resolution.skillUsed];
  const total = resolution.roll.value + skill;
  return [
    `  poi     ${what}, guarded ${guard.type} ${guard.strength}`,
    `  roll    ${resolution.roll.value} + ${resolution.skillUsed} ${skill} = ${total} vs ${guard.strength}` +
      ` — ${resolution.claimed ? 'taken' : 'stays on the node, no other cost'}`,
  ];
}

function terrainOf(run: Playthrough, node: NodeId): Terrain {
  const found = run.map.graph.nodes[node];
  if (found === undefined) throw new Error(`unknown node ${node}`);
  return found.terrain;
}

function statLine(name: string, stats: PlayerStats): string {
  return (
    `stats ${name}  stamina ${String(stats.stamina).padStart(3, ' ')}  gold ${String(stats.gold).padStart(2, ' ')}` +
    `  plains_move ${stats.plains_move}  forest_move ${stats.forest_move}  mountain_move ${stats.mountain_move}` +
    `  fighting ${stats.fighting}  magic ${stats.magic}`
  );
}
