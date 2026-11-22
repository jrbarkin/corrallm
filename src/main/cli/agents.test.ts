import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCommand } from './args';
import type { AgentCommand } from './args';
import { agentCommand } from './agents';
import { CliFailure } from './mcp-client';
import type { McpClient } from './mcp-client';

const canvas = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const listed = [{ id: 'a', name: 'Builder', adapter: 'zed', state: 'idle' }];
let folder: string;
let printed: string[];
let said: string[];
let calls: [string, Record<string, unknown>][];
let result: Record<string, unknown>;
let client: McpClient;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'agent-cli-'));
  printed = [];
  said = [];
  calls = [];
  result = { revs: {} };
  client = {
    call: (op, args) => {
      calls.push([op, args]);
      if (op === 'canvas.list')
        return Promise.resolve({ items: [{ canvas, name: 'work.corral' }] });
      if (op === 'agents') return Promise.resolve({ agents: listed });
      if (op === 'status') return Promise.resolve({ agents: [], next: 'before' });
      if (op === 'canvas.addAgent') return Promise.resolve({ id: 'new', revs: {} });
      if (op === 'message') return Promise.resolve({ id, revs: {} });
      return Promise.resolve(result);
    },
  };
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
const stdin = async function* () {
  yield await Promise.resolve(Buffer.from('brief exactly\n'));
};
function run(argv: string[], extra: Partial<Parameters<typeof agentCommand>[1]> = {}) {
  return agentCommand(parseCommand(argv) as AgentCommand, {
    env: {},
    cwd: folder,
    client,
    stdin: stdin(),
    print: (line) => printed.push(line),
    say: (line) => said.push(line),
    ...extra,
  });
}

describe('agent shell commands', () => {
  it('retries a dropped discovery read before sending any work', async () => {
    const original = client.call;
    let attempts = 0;
    client.call = async (op, args) => {
      if (op === 'canvas.list' && attempts++ === 0)
        throw new CliFailure(3, { code: 'unavailable', sentence: 'Dropped' });
      if (op === 'wait')
        return {
          messages: [
            {
              kind: 'text',
              from: 'agent:a',
              replyTo: id,
              body: 'Done',
              turn: { status: 'completed' },
            },
          ],
        };
      return original(op, args);
    };
    let tick = 0;
    const sleep = vi.fn((ms: number) => {
      tick += ms;
      return Promise.resolve();
    });
    expect(
      await run(['ask', '--canvas', canvas, '--to', 'a', '-'], { sleep, now: () => tick }),
    ).toBe(0);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(calls.filter(([op]) => op === 'message')).toHaveLength(1);
  });
  it('does not call an unrelated human decision a waiting native turn', async () => {
    const original = client.call;
    client.call = async (op, args) => {
      if (op === 'status')
        return {
          agents: [{ id: 'a', state: 'working', waitingForYou: [{ id: 'proposal/other' }] }],
          next: 'before',
        };
      if (op === 'wait')
        return {
          messages: [
            {
              kind: 'text',
              from: 'agent:a',
              replyTo: id,
              body: 'Done',
              turn: { status: 'completed' },
            },
          ],
        };
      return original(op, args);
    };
    expect(await run(['ask', '--canvas', canvas, '--to', 'a', '-'])).toBe(0);
    expect(said).toEqual([]);
  });
  it('does not replay a send whose response was dropped', async () => {
    const original = client.call;
    client.call = async (op, args) => {
      if (op === 'message') {
        calls.push([op, args]);
        throw new CliFailure(3, { code: 'unavailable', sentence: 'Dropped' });
      }
      return original(op, args);
    };
    expect(await run(['ask', '--canvas', canvas, '--to', 'a', '-'])).toBe(3);
    expect(calls.filter(([op]) => op === 'message')).toHaveLength(1);
  });
  it('stops on an expired credential instead of retrying it', async () => {
    const original = client.call;
    client.call = async (op, args) => {
      if (op === 'wait') throw new CliFailure(2, { code: 'refused', sentence: 'Expired' });
      return original(op, args);
    };
    const sleep = vi.fn();
    expect(await run(['ask', '--canvas', canvas, '--to', 'a', '-'], { sleep })).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('ends a quiet wait with the timeout exit code after a complete empty poll', async () => {
    let tick = 0;
    const original = client.call;
    client.call = async (op, args, ms) => {
      if (op === 'wait') {
        expect(ms).toBeGreaterThan(Number(args.timeoutSeconds) * 1000);
        tick += Number(args.timeoutSeconds) * 1000;
        return { messages: [], next: 'end' };
      }
      return original(op, args);
    };
    expect(
      await run(['ask', '--canvas', canvas, '--to', 'a', '--timeout', '1', '-'], {
        now: () => tick,
      }),
    ).toBe(1);
    expect(printed).toEqual([]);
  });
  it('lists only reached canvases, or the selected canvas’s agent result', async () => {
    expect(await run(['agents'])).toBe(0);
    expect(JSON.parse(printed[0] ?? '')).toEqual({ items: [{ canvas, name: 'work.corral' }] });
    printed = [];
    expect(await run(['agents', '--canvas', 'work.corral'])).toBe(0);
    expect(JSON.parse(printed[0] ?? '')).toEqual({ agents: listed });
  });
  it('creates with a role, then applies requested model and effort through saved settings', async () => {
    await writeFile(path.join(folder, 'role'), 'Review carefully');
    expect(
      await run([
        'agent',
        'add',
        '--canvas',
        canvas,
        '--cli',
        'zed',
        '--model',
        'm1',
        '--effort',
        'high',
        '--role-file',
        'role',
      ]),
    ).toBe(0);
    expect(calls.find(([op]) => op === 'canvas.addAgent')?.[1]).toMatchObject({
      canvas,
      adapter: 'zed',
      at: { x: 0, y: 0 },
      role: 'Review carefully',
    });
    expect(calls.at(-1)).toEqual([
      'agent.setSettings',
      expect.objectContaining({
        canvas,
        agent: 'new',
        adapter: 'zed',
        settings: { model: 'm1', effort: 'high' },
      }),
    ]);
    expect(printed.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 'new', revs: {} },
      { revs: {} },
    ]);
  });
  it.each([
    [['--connection', 'zed.free'], 'agent.setConnection', { connection: 'zed.free' }],
    [
      ['--cli', 'bare', '--connection', 'bare.pipe'],
      'agent.setType',
      { adapter: 'bare', connection: 'bare.pipe' },
    ],
    [
      ['--model', 'm2', '--effort', ''],
      'agent.setSettings',
      { adapter: 'zed', settings: { model: 'm2', effort: null } },
    ],
  ] as const)('maps a setting to its registered operation (%j)', async (flags, op, args) => {
    result = { proposed: 'proposal/one' };
    expect(await run(['agent', 'set', '--canvas', canvas, '--agent', 'Builder', ...flags])).toBe(0);
    expect(calls.at(-1)).toEqual([op, expect.objectContaining({ canvas, agent: 'a', ...args })]);
    expect(printed).toEqual([JSON.stringify(result)]);
  });
  it('applies combined edits in one batch, preserving a proposal without applying follow-ups', async () => {
    result = { proposed: 'proposal/one' };
    expect(
      await run([
        'agent',
        'set',
        '--canvas',
        canvas,
        '--agent',
        'a',
        '--connection',
        'zed.free',
        '--model',
        'm1',
      ]),
    ).toBe(0);
    expect(calls.at(-1)).toEqual([
      'canvas.batch',
      expect.objectContaining({
        ops: [
          { op: 'agent.setConnection', args: { agent: 'a', connection: 'zed.free' } },
          {
            op: 'agent.setSettings',
            args: { agent: 'a', adapter: 'zed', settings: { model: 'm1' } },
          },
        ],
      }),
    ]);
    expect(printed).toEqual([JSON.stringify(result)]);
  });
  it('uses the normal delete operation and keeps its proposed result', async () => {
    result = { proposed: 'proposal/delete' };
    expect(await run(['agent', 'rm', '--canvas', canvas, '--agent', 'Builder'])).toBe(0);
    expect(calls.at(-1)).toEqual([
      'canvas.delete',
      expect.objectContaining({ canvas, nodes: ['a'] }),
    ]);
    expect(printed).toEqual([JSON.stringify(result)]);
  });
  it('sends a file or stdin verbatim and prints only the message id', async () => {
    await writeFile(path.join(folder, 'brief'), 'file brief\n');
    expect(await run(['send', '--canvas', canvas, '--to', 'Builder', '--brief', 'brief'])).toBe(0);
    expect(calls.at(-1)).toEqual([
      'message',
      expect.objectContaining({ canvas, to: 'a', body: 'file brief\n' }),
    ]);
    expect(printed).toEqual([id]);
    expect(await run(['send', '--canvas', canvas, '--to', 'a', '-'])).toBe(0);
    expect(calls.at(-1)?.[1].body).toBe('brief exactly\n');
  });
  it('preserves a UTF-8 byte-order mark in a brief', async () => {
    await writeFile(path.join(folder, 'brief'), '\ufeffBrief');
    expect(await run(['send', '--canvas', canvas, '--to', 'a', '--brief', 'brief'])).toBe(0);
    expect(calls.at(-1)?.[1].body).toBe('\ufeffBrief');
  });
  it('rejects ambiguous names and oversized text before a mutation', async () => {
    const original = client.call;
    client.call = async (op, args) =>
      op === 'agents' ? { agents: [...listed, { ...listed[0], id: 'b' }] } : original(op, args);
    expect(await run(['agent', 'rm', '--canvas', canvas, '--agent', 'Builder'])).toBe(5);
    expect(calls.map(([op]) => op)).not.toContain('canvas.delete');
    expect(
      await run(['send', '--canvas', canvas, '--to', 'a', '-'], {
        stdin: (async function* () {
          yield await Promise.resolve(Buffer.alloc(16385, 65));
        })(),
      }),
    ).toBe(64);
    expect(calls.map(([op]) => op)).not.toContain('message');
  });
  it('retries a dropped wait, keeps its cursor, ignores notices and prints person-waiting once', async () => {
    let tick = 0;
    let waits = 0;
    const original = client.call;
    const reply = {
      id: 'reply',
      from: 'agent:a',
      kind: 'text',
      body: 'Done',
      replyTo: id,
      turn: { status: 'completed', reason: 'completed' },
    };
    client.call = async (op, args) => {
      if (op === 'status') return { agents: [{ id: 'a', state: 'waiting' }], next: 'before' };
      if (op === 'wait') {
        calls.push([op, args]);
        waits++;
        if (waits <= 2) throw new CliFailure(3, { code: 'unavailable', sentence: 'Dropped' });
        return waits === 3
          ? { messages: [{ kind: 'notice', replyTo: id }], next: 'after-notice' }
          : { messages: [reply], next: 'after-reply' };
      }
      return original(op, args);
    };
    const sleep = vi.fn((ms: number) => {
      tick += ms;
      return Promise.resolve();
    });
    expect(
      await run(['ask', '--canvas', canvas, '--to', 'a', '--timeout', '10', '-'], {
        now: () => tick,
        sleep,
      }),
    ).toBe(0);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(calls.filter(([op]) => op === 'message')).toHaveLength(1);
    expect(calls.filter(([op]) => op === 'wait').map(([, args]) => args.after)).toEqual([
      'before',
      'before',
      'before',
      'after-notice',
    ]);
    expect(printed).toEqual([JSON.stringify(reply)]);
    expect(said).toEqual(['Waiting for the person.']);
  });
});
