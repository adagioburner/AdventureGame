import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRulebook, spansOf } from './rulebook.ts';

describe('parseRulebook', () => {
  it('reads headings, paragraphs, lists and tables', () => {
    const blocks = parseRulebook(
      ['# Title', '', 'One line', 'and the next.', '', '- **Move.** Walk.', '- *Rest.*', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, spans: [{ text: 'Title', style: 'plain' }] },
      { kind: 'paragraph', spans: [{ text: 'One line and the next.', style: 'plain' }] },
      {
        kind: 'list',
        items: [
          [
            { text: 'Move.', style: 'bold' },
            { text: ' Walk.', style: 'plain' },
          ],
          [{ text: 'Rest.', style: 'italic' }],
        ],
      },
      {
        kind: 'table',
        head: [[{ text: 'A', style: 'plain' }], [{ text: 'B', style: 'plain' }]],
        rows: [[[{ text: '1', style: 'plain' }], [{ text: '2', style: 'plain' }]]],
      },
    ]);
  });

  it('keeps bold and italic runs apart', () => {
    expect(spansOf('A speed of *N* is **greater than** 0')).toEqual([
      { text: 'A speed of ', style: 'plain' },
      { text: 'N', style: 'italic' },
      { text: ' is ', style: 'plain' },
      { text: 'greater than', style: 'bold' },
      { text: ' 0', style: 'plain' },
    ]);
  });

  it('reads docs/RULEBOOK.md into its sections and tables', () => {
    const blocks = parseRulebook(readFileSync(new URL('../../../../docs/RULEBOOK.md', import.meta.url), 'utf8'));
    const headings = blocks.filter((block) => block.kind === 'heading' && block.level === 2);
    expect(headings.length).toBeGreaterThanOrEqual(8);
    const tables = blocks.filter((block) => block.kind === 'table');
    expect(tables.length).toBeGreaterThanOrEqual(5);
    for (const table of tables) {
      if (table.kind !== 'table') continue;
      expect(table.head.length).toBeGreaterThan(0);
      for (const row of table.rows) expect(row.length).toBe(table.head.length);
    }
  });
});
