import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { HostEvent } from './connector';
import { FakeConnector, fakeScript } from './fake';
import type { FakeScript } from './fake';

it('reports context before a fake turn ends', async () => {
  const events: HostEvent[] = [];
  const session = await new FakeConnector().start(
    {
      agentId: 'a',
      cwd: '/unused',
      env: {},
      model: null,
      mode: 'acceptEdits',
      resume: null,
    },
    {
      emit: (event) => {
        events.push(event);
      },
      remember: vi.fn(),
    },
  );
  try {
    await session.send({ id: 'message', text: 'Hello' });
    await expect.poll(() => events.some((event) => event.type === 'end')).toBe(true);
    const beforeEnd = events.slice(
      0,
      events.findIndex((event) => event.type === 'end'),
    );
    expect(beforeEnd.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
      usage: { context: { used: 1000, window: 200000, compactAt: 167000 } },
    });
  } finally {
    await session.close();
  }
});

describe('a scripted fake (CORRALLM_FAKE_SCRIPT, for the README media only)', () => {
  const script: FakeScript = {
    pause: 0,
    turns: [
      {
        when: 'cart endpoint',
        thinking: 'Totals come from the pricing helper.',
        tools: [
          { tool: 'Read', summary: 'src/pricing.ts' },
          {
            tool: 'Edit',
            summary: 'src/cart.ts',
            diff: [
              { kind: 'same', text: 'export const routes = [' },
              { kind: 'add', text: '  cart,' },
            ],
          },
          { tool: 'Bash', summary: 'pnpm test cart', output: '6 passed' },
        ],
        reply: 'Added the **cart** endpoint, with tests.',
      },
      { reply: 'Done.' },
    ],
  };

  async function turn(text: string, given = script) {
    const events: HostEvent[] = [];
    const session = await new FakeConnector({ script: given }).start(
      { agentId: 'a', cwd: '/unused', env: {}, model: null, mode: 'manual', resume: null },
      {
        emit: (event) => {
          events.push(event);
        },
        remember: vi.fn(),
      },
    );
    return { events, session, sent: session.send({ id: 'm', text }) };
  }

  const ended = (events: HostEvent[]) => events.some((event) => event.type === 'end');
  const said = (events: HostEvent[], type: 'text' | 'thinking') =>
    events.flatMap((event) => (event.type === type ? [event.text] : [])).join('');

  it('plays the turn whose words the message holds: thinking, tools and a streamed reply', async () => {
    const { events, session, sent } = await turn('Add the cart endpoint, please.');
    await sent;
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    expect(said(events, 'thinking')).toBe('Totals come from the pricing helper.');
    expect(said(events, 'text')).toBe('Added the **cart** endpoint, with tests.');
    // Streamed: more than one piece of the reply.
    expect(events.filter((event) => event.type === 'text').length).toBeGreaterThan(1);
    const tools = events.flatMap((event) => (event.type === 'tool' ? [event] : []));
    expect(tools.map(({ tool, status }) => `${tool} ${status}`)).toEqual([
      'Read running',
      'Read done',
      'Edit running',
      'Edit done',
      'Bash running',
      'Bash done',
    ]);
    expect(tools[3]?.detail).toEqual({
      kind: 'diff',
      added: 1,
      removed: 0,
      lines: [
        { kind: 'same', text: 'export const routes = [' },
        { kind: 'add', text: '  cart,' },
      ],
    });
    expect(tools[5]?.detail).toEqual({ kind: 'output', text: '6 passed' });
    // A scripted turn never asks, whatever its mode.
    expect(events.some((event) => event.type === 'permission')).toBe(false);
    expect(events.find((event) => event.type === 'end')).toMatchObject({
      messages: ['m'],
      result: { status: 'completed' },
    });
  });

  it('streams a list item with its first words, never a bare marker', async () => {
    const { events, session } = await turn('Something', {
      pause: 0,
      turns: [{ reply: 'It now:\n\n- opens from the header\n- closes on Esc\n\n1. and more' }],
    });
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    const pieces = events.flatMap((event) => (event.type === 'text' ? [event.text] : []));
    expect(pieces.join('')).toBe(
      'It now:\n\n- opens from the header\n- closes on Esc\n\n1. and more',
    );
    expect(pieces.filter((piece) => /(?:^|\n)\s*(?:[-*]|\d+\.)\s*$/.test(piece))).toEqual([]);
  });

  it('plays the turn with no words for any other message', async () => {
    const { events, session } = await turn('Something unscripted');
    await expect.poll(() => ended(events)).toBe(true);
    await session.close();
    expect(said(events, 'text')).toBe('Done.');
  });

  it('stops at once when interrupted, marking its running tool interrupted', async () => {
    const { events, session } = await turn('Something', {
      pause: 60_000,
      turns: [{ tools: [{ tool: 'Bash', summary: 'pnpm test' }], reply: 'Done.' }],
    });
    await expect.poll(() => events.some((event) => event.type === 'tool')).toBe(true);
    await session.interrupt();
    await expect.poll(() => ended(events)).toBe(true);
    expect(
      events.flatMap((event) => (event.type === 'tool' ? [`${event.tool} ${event.status}`] : [])),
    ).toEqual(['Bash running', 'Bash interrupted']);
    expect(events.find((event) => event.type === 'end')).toMatchObject({
      result: { status: 'cancelled' },
    });
  });
});

describe('fakeScript', () => {
  it('reads no script without the variable', () => {
    expect(fakeScript({})).toBeUndefined();
  });

  it('reads the JSON file the variable names, and refuses a malformed one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corrallm-fake-script-'));
    try {
      const good = path.join(dir, 'good.json');
      writeFileSync(good, JSON.stringify({ pause: 5, turns: [{ when: 'x', reply: 'y' }] }));
      expect(fakeScript({ CORRALLM_FAKE_SCRIPT: good })).toEqual({
        pause: 5,
        turns: [{ when: 'x', reply: 'y' }],
      });
      const bad = path.join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ pause: 5, turns: [{ when: 'x' }] }));
      expect(() => fakeScript({ CORRALLM_FAKE_SCRIPT: bad })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
