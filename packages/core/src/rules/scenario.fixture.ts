import { DEFAULT_RULESET, type RewardKind, type Terrain } from '@adventure/config';
import type { DieRoll } from '../action.ts';
import type { GameMap } from '../gamemap.ts';
import type { MapGraph } from '../graph.ts';
import { asGameId, asNodeId, asPlayerId, type NodeId, type PlayerId } from '../ids.ts';
import type { PlayerState, PlayerStats } from '../player.ts';
import type { Poi } from '../poi.ts';
import type { Guard } from '../reward.ts';
import type { GameState } from '../state.ts';
import { refreshAllowance } from './movement.ts';
import { createGameState } from './setup.ts';
import type { DiceSource } from './turn.ts';

/**
 * Hand-built games for the rules tests.
 *
 * Not part of the package's API — nothing here is exported from `index.ts`, and
 * the file is named `*.fixture.ts` rather than `*.test.ts` so Vitest does not
 * collect it as a suite while `tsconfig.json` still typechecks it.
 *
 * The rules tests want maps they can reason about line by line — §8's worked
 * example is five specific steps over four specific terrains — and a generated
 * map (§2.1) is both the wrong shape for that and unavailable here anyway,
 * since `@adventure/mapgen` depends on this package and not the other way
 * round.
 */

export const n = (value: number): NodeId => asNodeId(value);

export interface PoiSpec {
  readonly node: number;
  readonly kind: RewardKind;
  readonly units: number;
  readonly guard: Guard | null;
}

export interface MapSpec {
  /** One terrain per node; node ids are the array indices. */
  readonly terrains: readonly Terrain[];
  readonly edges: readonly (readonly [number, number])[];
  readonly pois?: readonly PoiSpec[];
}

export function fixtureMap(spec: MapSpec): GameMap {
  const adjacency: NodeId[][] = spec.terrains.map(() => []);
  for (const [a, b] of spec.edges) {
    (adjacency[a] as NodeId[]).push(n(b));
    (adjacency[b] as NodeId[]).push(n(a));
  }

  const graph: MapGraph = {
    nodes: spec.terrains.map((terrain, index) => ({
      id: n(index),
      position: { x: index, y: 0 },
      terrain,
    })),
    edges: spec.edges.map(([a, b]) => ({ a: n(a), b: n(b) })),
    adjacency,
  };

  const pois: Poi[] = (spec.pois ?? []).map((poi) => ({
    node: n(poi.node),
    terrain: spec.terrains[poi.node] as Terrain,
    reward: { kind: poi.kind, units: poi.units },
    guard: poi.guard,
    remoteness: 0.5,
    group: { kind: poi.kind, guard: poi.guard === null ? null : poi.guard.type },
    artVariant: 0,
  }));

  return {
    seed: 'fixture',
    ruleset: DEFAULT_RULESET,
    graph,
    pois,
    poiByNode: new Map(pois.map((poi, index) => [poi.node, index])),
    attempts: 1,
  };
}

/**
 * A game on `map` with `names.length` players, all on `startingNode`, seat 1 to
 * move. `PLAYER_COUNT.min` is 2, so two is the smallest legal game.
 */
export function fixtureGame(map: GameMap, startingNode: number, names: readonly string[] = ['one', 'two']): GameState {
  return createGameState({
    id: asGameId('fixture'),
    map,
    players: names.map((name) => ({
      id: asPlayerId(name),
      name,
      avatarId: `avatar-${name}`,
      control: 'human',
    })),
    startingNode: n(startingNode),
  });
}

export const player = (name: string): PlayerId => asPlayerId(name);

/**
 * Override a player's stats. Tests set the stat block a scenario calls for
 * (§8's is stamina 14, plains-move 3, forest-move 1, fighting 2) rather than
 * playing a game up to it; the active seat's allowance is refreshed with it, as
 * the start of a turn would have.
 */
export function withStats(state: GameState, id: PlayerId, stats: Partial<PlayerStats>): GameState {
  const players: PlayerState[] = state.players.map((current) =>
    current.id === id ? { ...current, stats: { ...current.stats, ...stats } } : current,
  );
  const active = players[state.turn.activeSeat - 1] as PlayerState;
  return {
    ...state,
    players,
    turn: { ...state.turn, allowance: refreshAllowance(active.stats) },
  };
}

/** Put a player somewhere other than the starting node. */
export function withPosition(state: GameState, id: PlayerId, node: number): GameState {
  return {
    ...state,
    players: state.players.map((current) => (current.id === id ? { ...current, position: n(node) } : current)),
  };
}

/**
 * A `DiceSource` that returns the given values in order, then throws. Tests
 * that care about a roll say which roll it is; a test that draws an unexpected
 * die fails loudly rather than quietly consuming a value.
 */
export function scriptedDice(values: readonly number[], sides = DEFAULT_RULESET.config.combat.GUARD_DIE.sides): DiceSource {
  let index = 0;
  return {
    roll(): DieRoll {
      const value = values[index++];
      if (value === undefined) throw new Error(`scripted dice exhausted after ${values.length} rolls`);
      return { value, sides };
    },
  };
}

/** A `DiceSource` that never expects to be asked — for turns with no guard in them. */
export const noDice: DiceSource = scriptedDice([]);
