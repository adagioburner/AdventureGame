import { useLayoutEffect, useRef, useState } from 'react';

/** [Q175] The game's name: the top bar's title, and the browser tab's (691). */
export const GAME_NAME = 'Skyholm Adventures';
/** [Q175] The name where the full one doesn't fit. */
export const GAME_NAME_SHORT = 'Skyholm';

/**
 * [Q175, 690] The game's name at the left of a top bar: Skyholm Adventures
 * wherever it fits on the bar's rows, Skyholm where it would push the bar onto
 * another row. It is judged by the room the bar actually has, and judged again
 * whenever the bar or anything in it changes size.
 */
export function GameTitle() {
  const title = useRef<HTMLHeadingElement | null>(null);
  const [short, setShort] = useState(false);

  useLayoutEffect(() => {
    const h1 = title.current;
    const bar = h1?.parentElement;
    if (h1 == null || bar == null) return;
    const fit = (): void => {
      const was = h1.classList.contains('short');
      h1.classList.add('short');
      const shortHeight = bar.getBoundingClientRect().height;
      h1.classList.remove('short');
      const fullHeight = bar.getBoundingClientRect().height;
      h1.classList.toggle('short', was);
      setShort(fullHeight > shortHeight + 0.5);
    };
    const sizes = new ResizeObserver(fit);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(bar);
      for (const child of bar.children) sizes.observe(child);
    };
    // The bar's buttons and labels come and go (a game starting, an end time
    // appearing), so the ones watched are refreshed with them.
    const contents = new MutationObserver(watch);
    watch();
    contents.observe(bar, { childList: true });
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) fit();
    });
    return () => {
      live = false;
      sizes.disconnect();
      contents.disconnect();
    };
  }, []);

  return (
    <h1 ref={title} className={`game-title${short ? ' short' : ''}`}>
      <span className="name-full">{GAME_NAME}</span>
      <span className="name-short">{GAME_NAME_SHORT}</span>
    </h1>
  );
}
