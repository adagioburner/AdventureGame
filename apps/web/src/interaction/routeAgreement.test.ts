import { describe, expect, it } from 'vitest';
import {
  applyAction,
  countWalk,
  createDiceSource,
  createRng,
  endTurnActionFor,
  isClaimed,
  poiRuntimeAt,
  refreshAllowance,
  walkTurnByTurn,
  type GameEvent,
  type GameState,
  type NodeId,
} from '@adventure/core';
import { HotseatGame } from '../modes/hotseat.ts';
import { mapFor } from '../page/seed.ts';
import { gamePreviewSource } from './moveMode.ts';

/**
 * [Q331] Andrei, 2026-11-05: "Is there anything else we can do to make sure
 * this change doesn't break anything?" Across the positions of games played
 * by End turn to sites picked at random, the route drawn while planning is
 * exactly what End turn then plays: the green and yellow steps are the steps
 * walked, its stamina is the stamina spent, and every step after is grey. And
 * the stop never spends more stamina this turn, nor takes more turns to
 * arrive, than a walk as far as each turn pays.
 */
describe('the route drawn is what End turn plays (Q331)', () => {
  for (const seed of ['adventure', 'quiet-harbor', 'misty-vale']) {
    it(`agrees step for step on ${seed}, on routes with and without a waypoint`, () => {
      const map = mapFor(seed, 'standard');
      const config = map.ruleset.config;
      const graph = map.graph;
      const game = new HotseatGame({
        map,
        seats: [
          { name: 'Ada', avatarId: 'player_avatars_01', control: 'human', thinkingSeconds: 10 },
          { name: 'Bram', avatarId: 'player_avatars_02', control: 'human', thinkingSeconds: 10 },
        ],
        diceSeed: `agree-${seed}`,
      });
      const rng = createRng(`agree-routes-${seed}`);
      const dice = createDiceSource(createRng(`agree-dice-${seed}`), config);
      let state: GameState = game.state;
      let checked = 0;
      let stopped = 0;
      for (let turn = 0; turn < 80 && state.status === 'in_progress'; turn++) {
        const me = state.players[state.turn.activeSeat - 1]!;
        const source = gamePreviewSource(state, me.id);
        const speeds = refreshAllowance(me.stats);
        for (let trial = 0; trial < 18; trial++) {
          const destination = rng.nextInt(graph.nodes.length) as NodeId;
          const waypoint = trial % 3 === 2 ? (rng.nextInt(graph.nodes.length) as NodeId) : null;
          if (destination === me.position || waypoint === me.position || waypoint === destination) continue;
          const shown = source.previewFor(destination, waypoint);
          if (shown === null) continue;
          const { path, preview, stops } = shown;
          const action = endTurnActionFor(state, me.id, path, waypoint);
          const reach = preview.reachableStepCount;
          expect(stops[0]).toBe(reach);
          expect(preview.steps.slice(reach).every((step) => step.color === 'unreachable')).toBe(true);
          // Walking as far as each turn pays: never less stamina this turn, never fewer turns.
          const asFar = countWalk(graph, path, 0, state.turn.allowance, me.stats.stamina, config);
          expect(preview.totalStaminaCost).toBeLessThanOrEqual(asFar.staminaSpent);
          expect(stops.length).toBeLessThanOrEqual(walkTurnByTurn(graph, path, state.turn.allowance, me.stats.stamina, speeds, config).turns);
          if (action.kind === 'rest') {
            expect(reach).toBe(0);
          } else {
            const moved = applyAction(state, action, dice).events.find((event): event is Extract<GameEvent, { type: 'moved' }> => event.type === 'moved');
            expect(moved?.resolution.walked).toEqual(path.slice(0, reach));
            expect(moved?.resolution.staminaSpent).toBe(preview.totalStaminaCost);
            if (action.stopAfter !== undefined) stopped++;
          }
          checked++;
        }
        // Play on: End turn on the way to a site still to be claimed, or a rest now and then.
        const open = map.pois.filter((poi) => {
          const runtime = poiRuntimeAt(state, poi.node);
          return runtime !== undefined && !isClaimed(runtime) && poi.node !== me.position;
        });
        const target = open[rng.nextInt(Math.max(open.length, 1))];
        const route = target === undefined ? null : source.previewFor(target.node, null);
        const next = route === null || rng.nextInt(6) === 0 ? { kind: 'rest' as const, player: me.id } : endTurnActionFor(state, me.id, route.path, null);
        state = applyAction(state, next, dice).state;
      }
      expect(checked).toBeGreaterThan(1000);
      // The stop came up, so the agreement was checked where it matters.
      expect(stopped).toBeGreaterThan(50);
    }, 120_000);
  }
});
