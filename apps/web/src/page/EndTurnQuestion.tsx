import { useEffect, useRef } from 'react';
import type { EndTurnQuestionKind } from '../interaction/moveMode.ts';

/** The least room the box leaves at the map's edges, in CSS pixels. */
const MARGIN_PX = 8;

/**
 * Where on the map the box goes: centred on `x`, its bottom edge at `above`,
 * or where there is no room above, its top edge at `below`.
 */
export interface QuestionPlace {
  readonly x: number;
  readonly above: number;
  readonly below: number;
}

/** [Q316] What the box says (8 C, 10 B); `gain` is the stamina a rest gives. */
function says(kind: EndTurnQuestionKind, gain: number): string {
  return kind === 'rest' ? `Your turn will end with a rest: +${gain} stamina.` : 'Your turn will end without claiming a reward or fighting for gold.';
}

/**
 * [Q316] Andrei, 2026-10-26: "we need to a[s]k for a confirmation [w]hen a
 * player ends their move not on a site. Players misclick way too often", and
 * "if one clicks End turn to rest, we probably should confirm as well". End
 * turn whose walk ends this turn off a site, or that rests
 * (`endTurnQuestion`), asks first, in a box drawn like the game's own panels
 * (3 B): "can it appear in the center, but above the end cross, so one [can]
 * see where they're going" (5). The map glides the cross to the middle (6 A),
 * or for a rest the figure (9 A), and the box sits just above it, following
 * it as the map moves, kept on the map, and going below it where there is no
 * room above. No closes it and keeps the route up to change, as Escape does;
 * Yes ends the turn (7 C).
 */
export function EndTurnQuestion({
  kind,
  restGain,
  locate,
  offline,
  onNo,
  onYes,
}: {
  kind: EndTurnQuestionKind;
  /** `REST_STAMINA_GAIN`. */
  restGain: number;
  /** Where the box goes for the end cross, or the figure that would rest, as the map shows it now; `null` while it cannot be found. */
  locate: () => QuestionPlace | null;
  /** [Q56, 71] The connection is down: Yes waits for it, as End turn does. */
  offline: boolean;
  onNo: () => void;
  onYes: () => void;
}) {
  const box = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let frame = 0;
    const follow = (): void => {
      const element = box.current;
      const stage = element?.offsetParent;
      const at = locate();
      if (element !== null && element !== undefined && stage instanceof HTMLElement && at !== null) {
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const left = Math.max(MARGIN_PX, Math.min(at.x - width / 2, stage.clientWidth - width - MARGIN_PX));
        const above = at.above - height;
        const top = above >= MARGIN_PX ? above : at.below;
        element.style.left = `${left}px`;
        element.style.top = `${Math.max(MARGIN_PX, Math.min(top, stage.clientHeight - height - MARGIN_PX))}px`;
        element.style.visibility = '';
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [locate]);

  return (
    <section className="end-question" ref={box} role="dialog" aria-label="End turn?" style={{ visibility: 'hidden' }}>
      <p>{says(kind, restGain)}</p>
      <p>End turn anyway?</p>
      <div className="acts">
        <button className="btn" type="button" onClick={onNo}>
          No
        </button>
        <button className="btn primary" type="button" disabled={offline} onClick={onYes}>
          Yes
        </button>
      </div>
    </section>
  );
}
