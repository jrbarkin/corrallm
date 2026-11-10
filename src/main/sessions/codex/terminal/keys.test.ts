import { describe, expect, it } from 'vitest';

import { codex } from '../adapter';
import { composerDraft } from './composer';
import { recordedScreen, recordedTerminal } from './recorded';
import type { TerminalRecord } from './recorded';

/*
 * Shift+Enter in Codex's TUI (B16 X2), on what the real Codex did (0.162.1, recorded in
 * fixtures/multiline.jsonl in a pseudo-terminal of 100×30, with a stub model API, a throwaway home
 * and the adapter's per-run flags): "line one", the sequence the descriptor declares, "line two",
 * then Enter. The model API's first request came only after Enter, as one message of two lines.
 * Probed in the same way, each by itself, but not kept in any fixture (unrecorded observations
 * from the same session): "\x1b\r" (Meta-Enter) and "\n" (Ctrl-J) also made a new line; xterm's
 * modifyOtherKeys form "\x1b[27;2;13~" and no sequence at all did not (the lines ran together).
 */

const terminal = codex.descriptor.connections.find((one) => one.id === 'codex.terminal');

/** What the stub model API was asked, as the recording noted it. */
const REQUEST = /^model request: (.*)$/s;

describe("Codex Terminal's Shift+Enter, as recorded", () => {
  const records = recordedTerminal('multiline');
  const keys = records.filter(
    (record): record is TerminalRecord & { kind: 'in' } => record.kind === 'in',
  );

  it('declares the sequence that made a new line in the recording', () => {
    const shiftEnter = keys[1]?.data;
    expect(shiftEnter).toBe('\x1b[13;2u');
    expect(terminal?.keys).toEqual({ shiftEnter });
  });

  it('does not submit a two-line draft on Shift+Enter: Enter does, as one message', () => {
    expect(keys.map((record) => record.data)).toEqual(['line one', '\x1b[13;2u', 'line two', '\r']);
    const enter = keys[3];
    const requests = records.filter(
      (record) => record.kind === 'note' && REQUEST.test(record.data),
    );
    // Nothing reached the model before Enter: Shift+Enter only edited the draft.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.t).toBeGreaterThan(enter?.t ?? Infinity);
    const [first] = requests;
    expect(first?.kind === 'note' && JSON.parse(REQUEST.exec(first.data)?.[1] ?? 'null')).toBe(
      'line one\nline two',
    );
  });

  it("shows Codex's own composer holding both lines, and no turn running, until Enter", async () => {
    const enter = keys[3];
    if (!enter) throw new Error('no Enter');
    const before = await recordedScreen('multiline', enter.t - 1);
    expect(composerDraft(before)).toBe('line one\nline two');
    const titles = records
      .filter((record) => record.kind === 'out' && record.t <= enter.t)
      .flatMap((record) =>
        record.kind === 'out'
          ? record.data
              .split('\x1b]0;')
              .slice(1)
              .map((one) => one.slice(0, one.indexOf('\x07')))
          : [],
      );
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.some((title) => /Working|Thinking/.test(title))).toBe(false);
    expect(titles.at(-1)).toMatch(/Ready$/);
    // Then Codex starts its turn.
    const after = records
      .filter((record) => record.kind === 'out' && record.t > enter.t)
      .map((record) => (record.kind === 'out' ? record.data : ''))
      .join('');
    expect(after).toMatch(/Working/);
  });
});
