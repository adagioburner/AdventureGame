import { useEffect, useRef, useState, type ReactNode } from 'react';

interface BarMenuProps {
  /** The Menu button's words: the online game's carries the count of unseen messages. */
  readonly label?: string | undefined;
  readonly children: ReactNode;
}

/**
 * [Q58, 84, Q71, 220 and Q72, 280 and 283] The top bar's buttons. On a phone,
 * held upright or turned sideways, they share one Menu button, whose list
 * opens under the bar at its right and closes on a choice or a press
 * elsewhere; on wider screens they sit in the bar and the Menu button is not
 * shown.
 */
export function BarMenu({ label = 'Menu', children }: BarMenuProps) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className={`bar-menu${open ? ' open' : ''}`} ref={menu}>
      <button className="btn menu-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      <div className="bar-actions" onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
  );
}
