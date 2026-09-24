import { poiAt, unclaimedGoldUnits, type GameEvent, type GameState } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import type { PlayedTurn } from '../modes/hotseat.ts';
import { GUARD_LABEL, STAT_LABEL, STAT_ORDER } from './journal.ts';
import { Die, Portrait, StatIcon } from './Sprites.tsx';

/**
 * What a turn ended on, when it ended on a POI (§8). A guarded one shows the
 * die, the skill added to it and the guard strength it was compared against,
 * whichever way it went, and stays until OK. [Andrei, 2026-09-24] An
 * unguarded one has no OK: the page fades it out by itself (`fading`).
 */
export function ResultCard({
  catalog,
  turn,
  rolling,
  fading,
  fadeMs,
  onClose,
}: {
  catalog: ArtCatalog;
  turn: PlayedTurn;
  rolling: boolean;
  fading: boolean;
  fadeMs: number;
  onClose: () => void;
}) {
  const interacted = turn.events.find((event): event is Extract<GameEvent, { type: 'interacted' }> => event.type === 'interacted');
  const reward = interacted?.resolution.reward ?? null;
  if (interacted === undefined || reward === null) return null;
  const { roll, skillUsed, claimed } = interacted.resolution;
  const guard = poiAt(turn.after.map, interacted.resolution.node)?.guard ?? null;
  const avatar = turn.after.players.find((player) => player.id === turn.player)?.avatarId ?? '';
  const prize = `${reward.units} ${STAT_LABEL[reward.kind]}`;

  return (
    <div
      className={`card result${rolling ? ' rolling' : claimed ? ' took' : ' missed'}${fading ? ' fading' : ''}`}
      style={{ transitionDuration: `${fadeMs}ms` }}
      role="status"
      aria-live="polite"
    >
      <header>
        <Portrait catalog={catalog} avatarId={avatar} size={40} label={turn.name} />
        <h2>
          {guard === null ? `${turn.name} found ${prize}` : `${turn.name} faces a ${GUARD_LABEL[guard.type]} guard of ${guard.strength}`}
        </h2>
      </header>
      {roll === null || skillUsed === null || guard === null ? (
        <p className="outcome">Unguarded, so it is taken: +{prize}.</p>
      ) : (
        <>
          <div className="roll">
            <Die catalog={catalog} value={roll.value} rolling={rolling} size={72} />
            {rolling ? (
              <p className="sum">Rolling…</p>
            ) : (
              <p className="sum">
                <b>{roll.value}</b> rolled + <b>{turn.statsBefore[skillUsed]}</b> {STAT_LABEL[skillUsed]} ={' '}
                <b>{roll.value + turn.statsBefore[skillUsed]}</b> against <b>{guard.strength}</b>
              </p>
            )}
          </div>
          {rolling ? null : (
            <p className="outcome">
              {claimed
                ? `More than ${guard.strength}: the guard is beaten. +${prize}.`
                : `Not more than ${guard.strength}: the ${STAT_LABEL[reward.kind]} stays on the node.`}
            </p>
          )}
        </>
      )}
      {rolling || guard === null ? null : (
        <button className="btn" type="button" onClick={onClose}>
          OK
        </button>
      )}
    </div>
  );
}

/**
 * [SOURCE §2] The game ends when one player's gold lead exceeds the gold still
 * on the map, or in a shared victory when players are tied with none left.
 * The engine decides that; this only says who and shows the final stats.
 */
export function EndCard({ catalog, state, onNewGame, onClose }: { catalog: ArtCatalog; state: GameState; onNewGame: () => void; onClose: () => void }) {
  const winners = state.players.filter((player) => state.winners.includes(player.id));
  const left = unclaimedGoldUnits(state);
  const title =
    winners.length === 1 ? `${winners[0]?.name ?? ''} wins!` : `Shared victory: ${winners.map((player) => player.name).join(' and ')}`;
  const ranked = [...state.players].sort((a, b) => b.stats.gold - a.stats.gold);
  const [first, second] = ranked;
  const why =
    winners.length > 1
      ? `Tied on ${first?.stats.gold ?? 0} gold with no gold left on the map.`
      : `${first?.stats.gold ?? 0} gold against ${second?.stats.gold ?? 0}: a lead of ${(first?.stats.gold ?? 0) - (second?.stats.gold ?? 0)}, more than the ${left} gold left on the map.`;

  return (
    <div className="card end" role="dialog" aria-label="The game is over">
      <h2>{title}</h2>
      <p className="outcome">
        {why} Game over after {state.turn.number} turns.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Player</th>
            {STAT_ORDER.map((kind) => (
              <th key={kind} scope="col" title={STAT_LABEL[kind]}>
                <StatIcon catalog={catalog} kind={kind} size={16} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((player) => (
            <tr key={player.id} className={state.winners.includes(player.id) ? 'winner' : ''}>
              <th scope="row">
                <Portrait catalog={catalog} avatarId={player.avatarId} size={24} label="" />
                {player.name}
              </th>
              {STAT_ORDER.map((kind) => (
                <td key={kind}>{player.stats[kind]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button className="btn primary" type="button" onClick={onNewGame}>
          New game
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Look at the map
        </button>
      </div>
    </div>
  );
}
