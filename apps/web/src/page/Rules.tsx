import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import rulebook from '../../../../docs/RULEBOOK.md?raw';
import { parseRulebook, type Block, type Span } from './rulebook.ts';

const BLOCKS: readonly Block[] = parseRulebook(rulebook);

/**
 * [Q71, 220, 221 and 231] Rules in a bar button's style: last in the top bar,
 * and last in the Menu on a phone held upright. Not on the screens before a
 * game starts (the setup on this device, login, and an online game's setup).
 *
 * [232 and 233] It opens the rulebook in the repository, `docs/RULEBOOK.md`,
 * over the whole game, with a Close button; the game stays as it is beneath.
 */
export function RulesButton() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  return (
    <>
      <button ref={button} className="btn" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Rules
      </button>
      {open ? createPortal(<Rulebook onClose={close} />, document.body) : null}
    </>
  );
}

/** [234] The rulebook in the game's own fonts and colours, its headings in the style of the word Adventure. */
function Rulebook({ onClose }: { onClose(): void }) {
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    close.current?.focus();
    // [236] While the rulebook is open the game's own keys do nothing (Escape would
    // put the planned route down): Escape closes the rulebook instead.
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="rules-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="rules-sheet" role="dialog" aria-modal="true" aria-label="Rules">
        <header className="rules-top">
          <button ref={close} className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="rules-text">{BLOCKS.map(blockOf)}</div>
      </section>
    </div>
  );
}

function blockOf(block: Block, key: number) {
  switch (block.kind) {
    case 'heading': {
      const Heading = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
      return <Heading key={key}>{textOf(block.spans)}</Heading>;
    }
    case 'paragraph':
      return <p key={key}>{textOf(block.spans)}</p>;
    case 'list':
      return (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={index}>{textOf(item)}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <table key={key}>
          {block.head.length === 0 ? null : (
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{textOf(cell)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{textOf(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

function textOf(spans: readonly Span[]) {
  return spans.map((span, index) =>
    span.style === 'bold' ? <b key={index}>{span.text}</b> : span.style === 'italic' ? <i key={index}>{span.text}</i> : <Fragment key={index}>{span.text}</Fragment>,
  );
}
