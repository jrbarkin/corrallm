import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import type { SpawnAppServer } from '../rpc';
import { recorded } from './recorded';
import type { Fixture, RecordedLine } from './recorded';

/*
 * For tests: an app server that replays what the real one said in a recording (recorded.ts), as
 * its client speaks: each message the client writes must be the next one the recording sent
 * (requests by method, answers to the server's requests), and whatever the server said next
 * follows. Request ids are the client's own (the recording's are mapped to them). It fails loudly
 * when the client says something the recording did not.
 */

export interface Replay {
  spawn: SpawnAppServer;
  /** What the client sent that the recording did not expect, if anything. */
  readonly problems: string[];
  /** The params of each request the client sent, by method, in order. */
  readonly sent: { method: string; params: unknown }[];
}

export function replay(name: Fixture): Replay {
  const lines = recorded(name);
  const problems: string[] = [];
  const sent: { method: string; params: unknown }[] = [];
  const spawn: SpawnAppServer = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: () => {
        finish();
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    let cursor = 0;
    let finished = false;
    /** The recording's request ids, as the client numbers them. */
    const ids = new Map<unknown, unknown>();
    const finish = () => {
      if (finished) return;
      finished = true;
      stdout.end();
      stdout.once('end', () => child.emit('close', 0));
      stdout.resume();
    };
    /** Says what the server said next, up to what it waited for from the client. */
    const pump = () => {
      while (cursor < lines.length) {
        const line: RecordedLine | undefined = lines[cursor];
        if (!line) return;
        if (line.dir === 'close') {
          cursor += 1;
          continue;
        }
        if (line.dir === 'out') return;
        cursor += 1;
        const { msg } = line;
        const answered = msg.method === undefined && ids.has(msg.id);
        stdout.write(`${JSON.stringify(answered ? { ...msg, id: ids.get(msg.id) } : msg)}\n`);
      }
    };
    createInterface({ input: stdin }).on('line', (text) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      // The interruption recording predates corrallm's per-command cleanup. Keep its native
      // traffic exact, but answer this added request as an older peer without that method.
      if (name === 'interrupt' && message.method === 'thread/backgroundTerminals/terminate') {
        sent.push({ method: message.method, params: message.params });
        stdout.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'This recording has no command termination response.' } })}\n`,
        );
        return;
      }
      // Role reconciliation reads current settings before resume. Older captures predate that
      // read-only request; supply an empty native setting without consuming recorded history.
      if (message.method === 'config/read' && lines[cursor]?.msg.method !== 'config/read') {
        sent.push({ method: message.method, params: message.params });
        stdout.write(`${JSON.stringify({ id: message.id, result: { config: {} } })}\n`);
        return;
      }
      // Skip what the recording sent that the client need not (none, so far).
      const expected = lines[cursor];
      if (expected?.dir !== 'out') {
        problems.push(`unexpected ${said(message)}`);
        return;
      }
      const wanted = expected.msg;
      const same =
        typeof message.method === 'string'
          ? message.method === wanted.method
          : wanted.method === undefined && message.id === wanted.id;
      if (!same) {
        problems.push(`sent ${said(message)}, recorded ${said(wanted)}`);
        return;
      }
      if (typeof message.method === 'string')
        sent.push({ method: message.method, params: message.params });
      if (message.id !== undefined && typeof message.method === 'string')
        ids.set(wanted.id, message.id);
      cursor += 1;
      pump();
    });
    stdin.on('finish', finish);
    queueMicrotask(pump);
    return child;
  };
  return { spawn, problems, sent };
}

/** A message, in a word: its method, or which request it answers. */
function said(message: Record<string, unknown>): string {
  const { method, id } = message;
  return typeof method === 'string' ? method : `the answer to ${JSON.stringify(id)}`;
}
