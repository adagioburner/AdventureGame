import { TERRAINS } from '@adventure/config';
import type { GameState } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import { STAT_LABEL, STAT_ORDER } from './journal.ts';
import { Portrait, StatIcon } from './Sprites.tsx';

/**
 * [SOURCE §6] "Per-player stats, uncapped: stamina, plains/forest/mountain
 * moving skill levels, fighting skill, magic skill, gold. Displayed for every
 * player to see, next to name and avatar."
 * [SOURCE §7.2] "The current player's name and avatar are prominently
 * displayed."
 *
 * Every number is read straight off the engine's `GameState`.
 */
export function Players({ catalog, state }: { catalog: ArtCatalog; state: GameState }) {
  const playing = state.status === 'in_progress';
  return (
    <section className="players" aria-label="Players">
      {state.players.map((player) => {
        const current = playing && player.seat === state.turn.activeSeat;
        const winner = state.winners.includes(player.id);
        return (
          <article key={player.id} className={`player${current ? ' current' : ''}${winner ? ' winner' : ''}`} aria-current={current ? 'true' : undefined}>
            <header>
              <Portrait catalog={catalog} avatarId={player.avatarId} size={current ? 52 : 40} label={`${player.name}’s avatar`} />
              <div className="who">
                <h2>{player.name}</h2>
                <span className="tag">{winner ? 'Winner' : current ? `Turn ${state.turn.number} · playing now` : `Seat ${player.seat}`}</span>
              </div>
            </header>
            <ul className="stats">
              {STAT_ORDER.map((kind) => (
                <li key={kind} title={STAT_LABEL[kind]}>
                  <StatIcon catalog={catalog} kind={kind} size={18} />
                  <b>{player.stats[kind]}</b>
                  <span className="label">{STAT_LABEL[kind]}</span>
                </li>
              ))}
            </ul>
            {current ? (
              <p className="allowance">
                Free steps left this turn:{' '}
                {TERRAINS.map((terrain) => `${terrain} ${state.turn.allowance[terrain]}`).join(' · ')}
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
