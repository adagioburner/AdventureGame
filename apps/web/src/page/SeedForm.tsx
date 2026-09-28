import { useRef } from 'react';
import { randomSeed } from './seed.ts';

interface SeedFormProps {
  /** What the field holds, typed or not yet drawn. */
  readonly draft: string;
  /** The seed whose map is drawn now. */
  readonly current: string;
  readonly maxLength?: number | undefined;
  /** Random waits while there is nobody to send its seed to. */
  readonly randomDisabled?: boolean | undefined;
  onDraftChange(next: string): void;
  /** Draw this seed's map: what was typed, untrimmed, or a random one. */
  onDraw(seed: string): void;
}

/**
 * The map seed in the top bar before a game starts, on this device and for an
 * online game's game master.
 *
 * [Q70, 225] There is no Draw button: Enter draws the seed typed, and so does
 * leaving the field. [226] A field left empty gets the current seed back.
 * [227] Random pressed straight after typing draws only its own map, not the
 * typed one first.
 */
export function SeedForm({ draft, current, maxLength, randomDisabled, onDraftChange, onDraw }: SeedFormProps) {
  const field = useRef<HTMLInputElement | null>(null);
  // Set while Random takes the field's focus itself, so leaving it draws nothing.
  const drawingRandom = useRef(false);

  const leave = (): void => {
    if (drawingRandom.current) return;
    if (draft.trim().length === 0) onDraftChange(current);
    else onDraw(draft);
  };

  const random = (): void => {
    drawingRandom.current = true;
    field.current?.blur();
    drawingRandom.current = false;
    onDraw(randomSeed());
  };

  return (
    <form
      className="seed"
      onSubmit={(event) => {
        event.preventDefault();
        onDraw(draft);
      }}
    >
      <label htmlFor="seed">Map seed</label>
      <input
        ref={field}
        id="seed"
        value={draft}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={leave}
      />
      <button
        className="btn"
        type="button"
        disabled={randomDisabled}
        // Pressing Random keeps the focus in the field until `random` moves it,
        // so the typed seed is not drawn on the way.
        onMouseDown={(event) => event.preventDefault()}
        onClick={random}
      >
        Random
      </button>
    </form>
  );
}
