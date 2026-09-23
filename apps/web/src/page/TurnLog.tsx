import { statLine, type JournalEntry } from './journal.ts';

/**
 * Every turn played so far, newest first, in words (`journal.ts`): where the
 * player was heading, which terrain each step entered and what paid for it,
 * why a walk stopped, what a guard roll added up to, and the stats after.
 */
export function TurnLog({ entries, mapSeed, diceSeed, onClose }: { entries: readonly JournalEntry[]; mapSeed: string; diceSeed: string; onClose?: () => void }) {
  return (
    <section className="log" aria-label="Turn log">
      <header>
        <h2>Turn log</h2>
        {onClose === undefined ? null : (
          <button className="btn close" type="button" onClick={onClose} aria-label="Close the turn log">
            ×
          </button>
        )}
      </header>
      <p className="muted">
        Map seed <code>{mapSeed}</code> · dice seed <code>{diceSeed}</code>. A moving skill of N makes the first N steps onto its
        terrain free each turn; other steps cost stamina (plains 1, forest 2, mountain 3).
      </p>
      {entries.length === 0 ? <p className="muted">Nothing played yet.</p> : null}
      <ol>
        {entries.map((entry) => (
          <li key={entry.number} className={`entry ${entry.tone}`}>
            <p className="turn">
              Turn {entry.number} · {entry.name}
            </p>
            <p className="headline">{entry.headline}</p>
            {entry.details.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="after">After: {statLine(entry.statsAfter)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
