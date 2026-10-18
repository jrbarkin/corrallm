import { describe, expect, it } from 'vitest';

import { parseProgramStatus } from './status';

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parseProgramStatus', () => {
  it('reads the reports Claude Code sends', () => {
    // As recorded from Claude Code 2.1.296.
    expect(parseProgramStatus('state=idle:app=claude-code')).toEqual({ state: 'idle' });
    expect(parseProgramStatus('state=working:app=claude-code')).toEqual({ state: 'working' });
    expect(parseProgramStatus('state=clear')).toEqual({ state: 'clear' });
  });

  it('reads what a blocked session waits for, its progress and its message', () => {
    expect(
      parseProgramStatus(
        `state=blocked:kind=permission:progress=40:msg=${base64('Bash: npm test')}:app=claude-code`,
      ),
    ).toEqual({ state: 'blocked', kind: 'permission', progress: 40, msg: 'Bash: npm test' });
    expect(
      parseProgramStatus(`state=error:msg=${base64('You’ve hit your limit · resets 3pm')}`),
    ).toEqual({ state: 'error', msg: 'You’ve hit your limit · resets 3pm' });
  });

  it('tells a background task’s record by its id', () => {
    expect(
      parseProgramStatus(`state=working:id=task-1/a:title=${base64('Explore the repo')}`),
    ).toEqual({ state: 'working', id: 'task-1/a', title: 'Explore the repo' });
  });

  it('ignores the probe, unknown states and keys, and values out of range', () => {
    expect(parseProgramStatus('?')).toBeUndefined();
    expect(parseProgramStatus('state=sleeping')).toBeUndefined();
    expect(parseProgramStatus('')).toBeUndefined();
    expect(parseProgramStatus('state=working:kind=coffee:progress=140:msg=!!!:future=yes')).toEqual(
      { state: 'working' },
    );
    // A message longer than the protocol allows (2048 bytes) is dropped.
    expect(parseProgramStatus(`state=error:msg=${base64('x'.repeat(2049))}`)).toEqual({
      state: 'error',
    });
  });
});
