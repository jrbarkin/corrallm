import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { Screen } from './screen';
import type { ProgramStatus } from './status';

/*
 * Excerpts of what Claude Code 2.1.296 printed in a pseudo-terminal (recorded, with the account
 * and folder names replaced): its prompt box at startup, as it redraws it with a draft, and its
 * folder trust dialog.
 */
const GREY = '\x1b[38;2;138;138;138m';
const PROMPT_BOX =
  ' Claude Code v2.1.296\r\r\n\r\r\n' +
  `${GREY}${'─'.repeat(70)}\x1b[71G\x1b[1m\x1b[38;2;135;0;255mu\x1b[22multracode\x1b[80G${GREY}─\x1b[39m\r\r\n` +
  '❯ \x1b[2mTry\x1b[7G"write\x1b[14Ga\x1b[16Gtest\x1b[21Gfor\x1b[25G<filepath>"\x1b[22m\r\r\n' +
  `${GREY}${'─'.repeat(80)}\x1b[39m\r\r\n` +
  '\x1b[3G\x1b[38;2;150;108;30m⏵⏵\x1b[6Gauto\x1b[11Gmode\x1b[16Gon\x1b[39m\r\r\n\x1b[2C\x1b[3A';
/** The prompt line redrawn with a draft (the cursor sits after the prompt mark). */
const DRAFT = '\r\x1b[2C\x1b[KFix the flaky test';
/** Its terminal probes at startup: the background colour, DA1, XTVERSION, kitty keys, Program Status, DA1. */
const PROBES = '\x1b]11;?\x07\x1b[c\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c';

function screen({ answers = true }: { answers?: boolean } = {}) {
  const replies: string[] = [];
  const reports: ProgramStatus[] = [];
  const made = new Screen({
    cols: 100,
    rows: 20,
    reply: (data) => replies.push(data),
    status: (report) => reports.push(report),
    answersQueries: () => answers,
  });
  return { screen: made, replies, reports };
}

describe('Screen', () => {
  it('answers the Program Status probe, and Device Attributes while no view does', async () => {
    const shown = screen();
    shown.screen.write(PROBES);
    await shown.screen.settled();
    expect(shown.replies).toEqual(['\x1b[?1;2c', '\x1b]7501;?\x1b\\', '\x1b[?1;2c']);

    const viewed = screen({ answers: false });
    viewed.screen.write(PROBES);
    await viewed.screen.settled();
    expect(viewed.replies).toEqual(['\x1b]7501;?\x1b\\']);
  });

  it('hears status reports, even split across writes', async () => {
    const { screen: made, reports } = screen();
    made.write('\x1b]7501;state=idle:app=claude-code\x07\x1b]7501;state=bl');
    made.write(
      'ocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiBnaXQgaW5pdCAtcQ==\x07',
    );
    made.write('\x1b]7501;state=clear\x1b\\');
    await made.settled();
    expect(reports).toEqual([
      { state: 'idle' },
      { state: 'blocked', kind: 'permission', msg: 'approve Bash: git init -q' },
      { state: 'clear' },
    ]);
  });

  it('snapshots the screen as written so far, which shows the same in another terminal', async () => {
    const { screen: made } = screen();
    made.write(PROMPT_BOX);
    const snapshot = made.snapshot();
    made.write(DRAFT);
    const { data, cols, rows } = await snapshot;
    expect({ cols, rows }).toEqual({ cols: 100, rows: 20 });

    const other = new Terminal({ cols, rows, allowProposedApi: true });
    await new Promise<void>((resolve) => {
      other.write(data, resolve);
    });
    const line = (y: number) => other.buffer.active.getLine(y)?.translateToString(true);
    expect(line(3)).toBe('❯ Try "write a test for <filepath>"');
    expect(data).not.toContain('Fix the flaky test');
    other.dispose();
  });

  it('says whether the cursor shows, as a CLI shows it where it takes typing', async () => {
    const { screen: made } = screen();
    expect(made.view().cursorShown).toBe(true);
    // A frame drawn with the cursor hidden, then shown again in the prompt.
    made.write('\x1b[?2026h\x1b[?25lOne moment\x1b[3;3H');
    await made.settled();
    expect(made.view().cursorShown).toBe(false);
    made.write('\x1b[?25h\x1b[?2026l');
    await made.settled();
    expect(made.view().cursorShown).toBe(true);
    // Other modes set alongside it leave it be.
    made.write('\x1b[?1049;25l\x1b[?1004h');
    await made.settled();
    expect(made.view().cursorShown).toBe(false);
  });

  it('takes a new size', () => {
    const { screen: made } = screen();
    made.resize(120, 40);
    expect([made.cols, made.rows]).toEqual([120, 40]);
  });
});
