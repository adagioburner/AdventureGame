import { existsSync, readFileSync } from 'node:fs';
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

  it('reads a picture on its own line, and one inside the text', () => {
    const blocks = parseRulebook(['Before.', '![A route](rulebook/route.png)', '', '| Icon |', '| --- |', '| ![](../Art/Icons/gold.png) Yellow coin |'].join('\n'));
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Before.', style: 'plain' }] },
      { kind: 'picture', alt: 'A route', src: 'rulebook/route.png' },
      {
        kind: 'table',
        head: [[{ text: 'Icon', style: 'plain' }]],
        rows: [
          [
            [
              { text: '', style: 'picture', src: '../Art/Icons/gold.png' },
              { text: ' Yellow coin', style: 'plain' },
            ],
          ],
        ],
      },
    ]);
  });

  it('finds every picture docs/RULEBOOK.md shows', () => {
    const docs = new URL('../../../../docs/', import.meta.url);
    const blocks = parseRulebook(readFileSync(new URL('RULEBOOK.md', docs), 'utf8'));
    const spans = blocks.flatMap((block) =>
      block.kind === 'heading' || block.kind === 'paragraph'
        ? block.spans
        : block.kind === 'list'
          ? block.items.flat()
          : block.kind === 'table'
            ? [...block.head, ...block.rows.flat()].flat()
            : [],
    );
    const sources = [
      ...blocks.flatMap((block) => (block.kind === 'picture' ? [block.src] : [])),
      ...spans.flatMap((span) => (span.style === 'picture' ? [span.src] : [])),
    ];
    expect(sources.length).toBeGreaterThan(0);
    const missing = sources.filter((src) => !existsSync(new URL(src, docs)));
    expect(missing).toEqual([]);
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
