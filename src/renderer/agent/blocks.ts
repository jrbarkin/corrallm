/*
 * The Markdown agents write, read into blocks: paragraphs, headings, fenced code, quotes, lists
 * (nested), tables and rules. Inline markup (code, bold, italic, links) is read when a block is
 * shown (Markdown.tsx). Replies arrive a little at a time, so anything left open (a code fence
 * not yet closed) reads as if it ended where the text does.
 */

export type Align = 'left' | 'center' | 'right' | undefined;

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** The blocks of `text`. */
export function parseMarkdown(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, '\n').split('\n'));
}

function blocks(lines: readonly string[]): Block[] {
  const found: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marks = '```', lang = ''] = fence;
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !closes(lines[i] ?? '', marks)) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      found.push({ kind: 'code', lang, text: code.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      found.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      found.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(QUOTE, ''));
        i += 1;
      }
      found.push({ kind: 'quote', blocks: blocks(quoted) });
      continue;
    }

    if (
      line.includes('|') &&
      TABLE_RULE.test(lines[i + 1] ?? '') &&
      (lines[i + 1] ?? '').includes('-')
    ) {
      const head = cells(line);
      const align = cells(lines[i + 1] ?? '').map((cell): Align => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
      });
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      found.push({ kind: 'table', head, align, rows });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const [list, next] = parseList(lines, i);
      found.push(list);
      i = next;
      continue;
    }

    // A paragraph: lines up to a blank one, or one that starts another block.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '' || (paragraph.length > 0 && startsBlock(next))) break;
      paragraph.push(next.trim());
      i += 1;
    }
    found.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return found;
}

/** Whether `line` closes a fence opened with `marks`. */
function closes(line: string, marks: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marks) && trimmed.replace(/[`~]/g, '') === '';
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || ITEM.test(line) || RULE.test(line)
  );
}

/** The list starting at line `from`, and the line after it. */
function parseList(lines: readonly string[], from: number): [Block, number] {
  const first = ITEM.exec(lines[from] ?? '');
  const indent = first?.[1]?.length ?? 0;
  const marker = first?.[2] ?? '-';
  const ordered = /\d/.test(marker);
  const items: string[][] = [];
  let i = from;
  let blank = false;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      blank = true;
      i += 1;
      continue;
    }
    const item = ITEM.exec(line);
    const depth = line.length - line.trimStart().length;
    if (item && depth === indent && /\d/.test(item[2] ?? '') === ordered) {
      // A new item: its text starts after its marker.
      items.push([item[3] ?? '']);
    } else if (depth > indent && items.length > 0) {
      // More of the item: nested, or continued.
      items.at(-1)?.push(line.slice(Math.min(depth, indent + (marker.length + 1))));
    } else if (!blank && items.length > 0 && !startsBlock(line)) {
      // A lazy continuation of its last line.
      items.at(-1)?.push(line.trim());
    } else {
      break;
    }
    blank = false;
    i += 1;
  }
  const start = ordered ? Number.parseInt(marker, 10) : 1;
  return [{ kind: 'list', ordered, start, items: items.map((item) => blocks(item)) }, i];
}

/** A table row's cells, without the outer pipes; "\|" is a pipe in a cell. */
function cells(row: string): string[] {
  const trimmed = row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Inline markup within a block's text. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' };

const INLINE: { kind: Inline['kind']; pattern: RegExp }[] = [
  { kind: 'code', pattern: /(`+)([\s\S]*?[^`])\1(?!`)/ },
  { kind: 'link', pattern: /\[([^\]\n]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/ },
  { kind: 'strong', pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/ },
  { kind: 'strike', pattern: /~~(?=\S)([\s\S]*?\S)~~/ },
  {
    kind: 'em',
    pattern: /\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/,
  },
];

/** The inline markup of `text`: code spans, emphasis, links, and line breaks. */
export function parseInline(text: string): Inline[] {
  const found: Inline[] = [];
  let rest = text;
  while (rest !== '') {
    let best: { kind: Inline['kind']; match: RegExpExecArray } | undefined;
    for (const { kind, pattern } of INLINE) {
      const match = pattern.exec(rest);
      if (match && (best === undefined || match.index < best.match.index)) best = { kind, match };
    }
    if (!best) {
      found.push(...lines(rest));
      break;
    }
    const { kind, match } = best;
    if (match.index > 0) found.push(...lines(rest.slice(0, match.index)));
    switch (kind) {
      case 'code':
        found.push({ kind: 'code', text: (match[2] ?? '').replace(/^ (.*) $/, '$1') });
        break;
      case 'link':
        found.push({ kind: 'link', href: match[2] ?? '', children: parseInline(match[1] ?? '') });
        break;
      case 'strong':
      case 'em':
      case 'strike':
        found.push({ kind, children: parseInline(match[1] ?? match[2] ?? '') });
        break;
      default:
        break;
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return found;
}

/** Text with its line breaks. */
function lines(text: string): Inline[] {
  return text
    .split('\n')
    .flatMap((part, i): Inline[] => [
      ...(i > 0 ? [{ kind: 'break' } as const] : []),
      ...(part === '' ? [] : [{ kind: 'text', text: part } as const]),
    ]);
}
