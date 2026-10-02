import { useLayoutEffect, useRef, useState } from 'react';
import type { RewardKind } from '@adventure/config';
import type { PlayerState } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import { STAT_LABEL } from './journal.ts';
import { StatIcon } from './Sprites.tsx';

/**
 * [Q190] Andrei, 2026-10-02: "allow players buy skills for gold, 1 to 1",
 * and "a separate buy panel in all cases, and a cancel option on it. This way,
 * if you misclick, you can always cancel" (768 to 770, 766).
 *
 * The Buy button on the card of the person on turn opens it, over the map:
 * next to the card, level with its top, where the cards stand in a column
 * (a laptop, a phone held sideways); across the top of the map where they
 * stand in a row above it (a phone held upright). Each + adds a unit to the
 * panel only: its tile's number goes up, with the units added in blue beside
 * it, and Your gold counts down. Done buys them all at once; Cancel puts
 * everything back. Only those two close it. A + greys out once the gold left
 * would not pay for another unit.
 */
export function BuyPanel({
  catalog,
  player,
  kinds,
  price,
  onDone,
  onCancel,
}: {
  catalog: ArtCatalog;
  player: PlayerState;
  kinds: readonly RewardKind[];
  price: number;
  /** The units picked, in the order their + was pressed; empty when none was. */
  onDone: (skills: readonly RewardKind[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<readonly RewardKind[]>([]);
  const left = player.stats.gold - picked.length * price;
  const panel = useRef<HTMLElement | null>(null);
  const [top, setTop] = useState<number | null>(null);

  // Level with the card's top where the card stands beside the map; at the
  // map's top where the cards are above it. Kept on the map either way.
  useLayoutEffect(() => {
    const place = (): void => {
      const box = panel.current;
      const stage = box?.offsetParent;
      const card = document.querySelector('.player.current');
      if (box === null || box === undefined || !(stage instanceof HTMLElement) || card === null) return;
      const map = stage.getBoundingClientRect();
      const at = card.getBoundingClientRect();
      const margin = 8;
      const room = map.height - box.offsetHeight - margin;
      setTop(at.bottom <= map.top ? margin : Math.max(margin, Math.min(at.top - map.top, room)));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  return (
    <section className="buy-panel" ref={panel} style={top === null ? { visibility: 'hidden' } : { top }} aria-label="Buy speeds and skills">
      <h3>Buy for {price} gold each</h3>
      <div className="tiles">
        {kinds.map((kind) => {
          const added = picked.filter((skill) => skill === kind).length;
          return (
            <div key={kind} className={`tile${added > 0 ? ' picked' : ''}`}>
              <StatIcon catalog={catalog} kind={kind} size={22} />
              <small>{STAT_LABEL[kind]}</small>
              <b>
                {player.stats[kind] + added}
                {added > 0 ? <em>+{added}</em> : null}
              </b>
              <button
                type="button"
                disabled={left < price}
                aria-label={`Add 1 ${STAT_LABEL[kind]}`}
                onClick={() => setPicked((current) => [...current, kind])}
              >
                +
              </button>
            </div>
          );
        })}
      </div>
      <div className="foot">
        <span className="your-gold">
          <StatIcon catalog={catalog} kind="gold" size={22} />
          Your gold <b>{left}</b>
        </span>
        <span className="acts">
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" type="button" onClick={() => onDone(picked)}>
            Done
          </button>
        </span>
      </div>
    </section>
  );
}
