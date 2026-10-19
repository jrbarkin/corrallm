import { describe, expect, it } from 'vitest';

import { Screen } from '../terminal/screen';
import type { ProgramStatus } from '../terminal/status';
import { ClaudeCode } from './claude-code';

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
/** A prompt box holding a draft of two lines. */
const TWO_LINES =
  '\x1b[H\x1b[2J' +
  `${GREY}${'─'.repeat(80)}\x1b[39m\r\r\n` +
  '❯ Fix the flaky test\r\r\n  and its fixture\r\r\n' +
  `${GREY}${'─'.repeat(80)}\x1b[39m\r\r\n`;
const TRUST_DIALOG =
  '\r\r\n\x1b[38;2;150;108;30m──────────────────────────────────────────\x1b[39m\r\r\n' +
  '\x1b[2G\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\r\r\n\r\r\n' +
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gtrust?\r\r\n\r\r\n' +
  '\x1b[2G\x1b[38;2;87;105;247m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n';
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

const cli = new ClaudeCode({ cwd: '/work', home: '/home', env: {} });

describe('Claude Code’s prompt', () => {
  it('reads Claude Code’s prompt: empty under its dim placeholder, or the user’s draft', async () => {
    const { screen: made } = screen();
    made.write(PROMPT_BOX);
    await made.settled();
    expect(cli.draft(made)).toBe('');
    made.write(DRAFT);
    await made.settled();
    expect(cli.draft(made)).toBe('Fix the flaky test');
    made.write(TWO_LINES);
    await made.settled();
    expect(cli.draft(made)).toBe('Fix the flaky test\nand its fixture');
  });

  it('finds no prompt while a dialog shows', async () => {
    const { screen: made } = screen();
    made.write(TRUST_DIALOG);
    await made.settled();
    expect(cli.draft(made)).toBeUndefined();
    expect(made.text()).toContain('Quick safety check');
  });
});
