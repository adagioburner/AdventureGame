import { useEffect, useRef } from 'react';
import { TERRAINS } from '@adventure/config';
import type { GameState, PlayerId } from '@adventure/core';
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
 *
 * [Q54, 31 and 33] Online, a player with no connection has "Away" on their card.
 */
export function Players({ catalog, state, away }: { catalog: ArtCatalog; state: GameState; away?: ReadonlySet<PlayerId> | undefined }) {
  const playing = state.status === 'in_progress';
  const list = useRef<HTMLElement | null>(null);
  // [Andrei, 2026-09-24] Q53: four or five cards scroll in their own column
  // (Q52), so at the start of each turn the column glides until the current
  // player's card shows. Only the column moves, and only if the card is out of
  // view; on a phone every card already shows.
  const turn = playing ? `${state.turn.number}:${state.turn.activeSeat}` : null;
  useEffect(() => {
    const column = list.current;
    const card = column?.querySelector<HTMLElement>('.player.current') ?? null;
    if (turn === null || column === null || card === null || column.scrollHeight <= column.clientHeight) return;
    const view = column.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(column).paddingTop) || 0;
    const by = box.top < view.top + padding ? box.top - view.top - padding : box.bottom > view.bottom - padding ? box.bottom - view.bottom + padding : 0;
    if (by !== 0) column.scrollBy({ top: by, behavior: 'smooth' });
  }, [turn]);
  return (
    <section className="players" aria-label="Players" ref={list}>
      {state.players.map((player) => {
        const current = playing && player.seat === state.turn.activeSeat;
        const winner = state.winners.includes(player.id);
        return (
          <article key={player.id} className={`player${current ? ' current' : ''}${winner ? ' winner' : ''}`} aria-current={current ? 'true' : undefined}>
            <header>
              <Portrait catalog={catalog} avatarId={player.avatarId} size={current ? 52 : 40} label={`${player.name}’s avatar`} />
              <div className="who">
                <h2>{player.name}</h2>
                <span className="tag">
                  {winner ? 'Winner' : current ? `Turn ${state.turn.number} · playing now` : `Seat ${player.seat}`}
                  {away?.has(player.id) === true ? ' · Away' : null}
                </span>
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
