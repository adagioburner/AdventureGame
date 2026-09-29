/**
 * [Q71, 232] The rulebook is `docs/RULEBOOK.md`, Andrei's own page copied into
 * the repository, and the game shows that file. This reads the little Markdown
 * it uses: headings, paragraphs, bulleted lists and tables, with **bold** and
 * *italic* inside them. Anything else is kept as a plain paragraph.
 */

/** A run of text: plain, **bold** or *italic*. */
export interface Span {
  readonly text: string;
  readonly style: 'plain' | 'bold' | 'italic';
}

export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly spans: readonly Span[] }
  | { readonly kind: 'paragraph'; readonly spans: readonly Span[] }
  | { readonly kind: 'list'; readonly items: readonly (readonly Span[])[] }
  | { readonly kind: 'table'; readonly head: readonly (readonly Span[])[]; readonly rows: readonly (readonly (readonly Span[])[])[] };

export function parseRulebook(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length as 1 | 2 | 3, spans: spansOf(heading[2] ?? '') });
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        items.push(spansOf((lines[i] ?? '').replace(/^\s*[-*]\s+/, '')));
        i += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
        rows.push(cellsOf(lines[i] ?? ''));
        i += 1;
      }
      const [head = [], divider, ...body] = rows;
      const hasHead = divider !== undefined && divider.every((cell) => /^:?-{3,}:?$/.test(cell));
      blocks.push({
        kind: 'table',
        head: hasHead ? head.map(spansOf) : [],
        rows: (hasHead ? body : rows).map((row) => row.map(spansOf)),
      });
      continue;
    }
    const text: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim().length === 0 || /^#{1,3}\s/.test(next) || /^\s*[-*]\s+/.test(next) || next.trimStart().startsWith('|')) break;
      text.push(next.trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', spans: spansOf(text.join(' ')) });
  }
  return blocks;
}

/** The cells of one table row, `| a | b |`, trimmed. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Splits text into plain, **bold** and *italic* runs. */
export function spansOf(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), style: 'plain' });
    if (match[1] !== undefined) spans.push({ text: match[1], style: 'bold' });
    else spans.push({ text: match[2] ?? '', style: 'italic' });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: 'plain' });
  return spans;
}
