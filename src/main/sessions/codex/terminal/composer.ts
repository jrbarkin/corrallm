import type { IBuffer } from '@xterm/headless';

import type { Screen } from '../../terminal/screen';

/*
 * Codex's composer, as its TUI draws it (0.160): near the bottom of the screen, its first line
 * starting with "› " and the text typed after it (a dim placeholder, as "Ask Codex to do
 * anything", while it is empty), a line after another indented, and the terminal's cursor shown in
 * it, where the user types. (It is shaded too, when the terminal said what its background is: a
 * view's terminal says, main's copy does not.) Past messages start with "› " as well, and dialogs
 * (an approval's choices) mark their choice with "›", but Codex hides the cursor while a dialog is
 * up, and never puts it in a past message. So the composer is where the cursor shows.
 */

const MARK = '›';

/**
 * What the user has typed in Codex's composer and not sent: '' when it is empty (or shows its
 * placeholder), undefined when the cursor does not show in a composer (a dialog, a picker, a
 * startup screen).
 */
export function composerDraft(screen: Screen): string | undefined {
  const { buffer, top, bottom, cursorShown } = screen.view();
  const cursor = buffer.baseY + buffer.cursorY;
  if (!cursorShown || cursor < top || cursor >= bottom) return undefined;
  // Up from the cursor, through the draft's lines, to its first.
  let first = cursor;
  while (first > top && !startsWithMark(buffer, first) && !blank(buffer, first)) first -= 1;
  if (!startsWithMark(buffer, first)) return undefined;
  const lines: string[] = [];
  const cell = buffer.getNullCell();
  // Down to the line after its last (blank: the composer's margin).
  for (let y = first; y < bottom && (y === first || !blank(buffer, y)); y += 1) {
    const line = buffer.getLine(y);
    let text = '';
    // Past the mark and its space (or the indent of a line after the first).
    for (let x = 2; line && x < line.length; x += 1) {
      const at = line.getCell(x, cell);
      if (!at || at.getWidth() === 0) continue;
      text += at.isDim() ? ' ' : at.getChars() || ' ';
    }
    lines.push(text.trimEnd());
  }
  return lines.join('\n').trim();
}

const text = (buffer: IBuffer, y: number) => buffer.getLine(y)?.translateToString(true) ?? '';

function startsWithMark(buffer: IBuffer, y: number): boolean {
  return text(buffer, y).startsWith(MARK);
}

function blank(buffer: IBuffer, y: number): boolean {
  return text(buffer, y).trim() === '';
}
