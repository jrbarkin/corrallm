import { describe, expect, it } from 'vitest';

import { MAX_TERMINAL_INPUT } from '../../shared/terminal';
import { TerminalLink } from './link';
import type { LinkState } from './link';
import { FakeScreen, fakeTerminals } from './test-screen';

function link() {
  const main = fakeTerminals();
  const screen = new FakeScreen(document.createElement('div'));
  const states: LinkState[] = [];
  const linked = new TerminalLink('a', main.backend, screen, (state) => states.push(state));
  linked.start();
  return { ...main, screen, states, linked };
}

const SCREEN = { type: 'screen', data: 'Claude Code\r\n❯ ', cols: 100, rows: 30 } as const;

describe('TerminalLink', () => {
  it('asks to see the agent’s terminal, and stops', () => {
    const { backend, listening, linked } = link();
    expect(backend.attach).toHaveBeenCalledWith('a');
    expect(listening()).toBe(true);
    linked.stop();
    expect(backend.detach).toHaveBeenCalledWith('a');
    expect(listening()).toBe(false);
  });

  it('starts from the screen main sends, at its size, then writes what the CLI prints', () => {
    const { emit, screen, states } = link();
    emit('a', SCREEN, { type: 'output', data: 'hi' });
    // Another agent's terminal is not this one.
    emit('b', { type: 'output', data: 'not mine' });
    expect(screen.shown).toBe('Claude Code\r\n❯ hi');
    expect(screen.size).toEqual({ cols: 100, rows: 30 });
    expect(states).toEqual([]);
    screen.finish();
    expect(states).toEqual([{ kind: 'live' }]);
  });

  it('drops what the terminal answers while the snapshot is written, then passes keystrokes on', () => {
    const { backend, emit, screen } = link();
    screen.type('before any screen');
    emit('a', SCREEN);
    // The terminal answers a query that was in the snapshot: the CLI asked it of another view.
    screen.type('\x1b[?1;2c');
    screen.finish();
    screen.type('hello');
    expect(backend.write.mock.calls).toEqual([['a', 'hello']]);

    const paste = 'x'.repeat(MAX_TERMINAL_INPUT + 10);
    screen.type(paste);
    expect(backend.write.mock.calls.slice(1).map(([, data]) => data.length)).toEqual([
      MAX_TERMINAL_INPUT,
      10,
    ]);
  });

  it('gives the CLI the view’s size once it shows its screen, and as the view resizes', () => {
    const { backend, emit, screen } = link();
    screen.fits = { cols: 120, rows: 40 };
    emit('a', SCREEN);
    expect(backend.resize).not.toHaveBeenCalled();
    screen.finish();
    expect(backend.resize.mock.calls).toEqual([['a', 120, 40]]);
    screen.fits = { cols: 90, rows: 40 };
    screen.fit();
    expect(backend.resize.mock.calls.at(-1)).toEqual(['a', 90, 40]);
  });

  it('says when the CLI exited, and takes no more keystrokes; a new one starts afresh', () => {
    const { backend, emit, screen, states } = link();
    emit('a', SCREEN);
    screen.finish();
    emit('a', { type: 'exit', code: 0 });
    expect(states.at(-1)).toEqual({ kind: 'exited', code: 0 });
    screen.type('x');
    expect(backend.write).not.toHaveBeenCalled();

    emit('a', { ...SCREEN, data: 'Resumed' });
    expect(screen.shown).toBe('Resumed');
    screen.finish();
    expect(states.at(-1)).toEqual({ kind: 'live' });
  });

  it('shows only the latest screen when another comes while one is written', () => {
    const { emit, screen, states } = link();
    emit('a', SCREEN);
    emit('a', { ...SCREEN, data: 'Newer' });
    screen.finish();
    expect(screen.shown).toBe('Newer');
    expect(states).toEqual([{ kind: 'live' }]);
  });
});
