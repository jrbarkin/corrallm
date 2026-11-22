import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import { SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import { MAX_ROLE_LENGTH } from '../../shared/session';
import { parseRole } from '../../shared/role';
import type { AgentCommand } from './args';
import { CliFailure, cliFailure, mcpClient, object, WAIT_SLACK_MS } from './mcp-client';
import type { McpClient } from './mcp-client';

interface AgentIO {
  env: NodeJS.ProcessEnv;
  cwd: string;
  print(line: string): void;
  say(line: string): void;
  stdin?: AsyncIterable<string | Uint8Array>;
  client?: McpClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const invalid = (sentence: string) => new CliFailure(64, { code: 'invalid', sentence });
const refused = (sentence: string) => new CliFailure(5, { code: 'not-found', sentence });
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new CliFailure(3, { code: 'unavailable', sentence: 'The server gave no list.' });
  return value.map(object);
}
function named(items: Record<string, unknown>[], text: string, key: string, label: string) {
  const direct = items.find((item) => item[key] === text);
  if (direct !== undefined) return direct;
  const matches = items.filter((item) => item.name === text);
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw refused(
      matches.length === 0
        ? `No reached ${label} matches that id or name.`
        : `That ${label} name is ambiguous. Use its id.`,
    );
  return match;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new CliFailure(3, { code: 'unavailable', sentence: 'The server gave no identifier.' });
  return value;
}

/** Shell access uses only registered operations, under the credential's existing authority. */
export async function agentCommand(command: AgentCommand, io: AgentIO): Promise<number> {
  const client =
    io.client ??
    mcpClient({
      env: io.env,
      cwd: io.cwd,
      ...(command.tokenFile === undefined ? {} : { tokenFile: command.tokenFile }),
    });
  const now = io.now ?? (() => performance.now());
  const sleep =
    io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (command.command === 'ask' ? command.timeout : 0) * 1000;
  const call = async (op: OpName, args: Record<string, unknown>) => {
    const read = SURFACE[op].kind === 'read';
    const input = { ...(read ? {} : { request: randomUUID() }), ...args };
    let delay = 250;
    for (;;) {
      try {
        return await client.call(op, input);
      } catch (error) {
        const failure = cliFailure(error);
        const left = deadline - now();
        if (command.command !== 'ask' || !read || failure.exitCode !== 3 || left <= 0)
          throw failure;
        await sleep(Math.min(delay, left));
        delay = Math.min(5000, delay * 2);
      }
    }
  };
  const print = (value: unknown) => {
    io.print(JSON.stringify(value));
  };
  try {
    // Validate local text before any mutation; reading a brief never mints a trusted path.
    const body =
      command.command === 'send' || command.command === 'ask'
        ? await brief(command.brief, io)
        : undefined;
    const role =
      command.command === 'agent' && command.roleFile !== undefined
        ? await readText(
            path.resolve(io.cwd, command.roleFile),
            MAX_ROLE_LENGTH * 4,
            MAX_ROLE_LENGTH,
          )
        : undefined;
    if (role !== undefined) {
      try {
        parseRole(role);
      } catch {
        throw invalid('The role file does not contain a valid bounded role.');
      }
    }
    const canvases = await call('canvas.list', {});
    if (command.command === 'agents' && command.canvas === undefined) {
      print(canvases);
      return 0;
    }
    const canvas = identifier(
      named(rows(canvases.items), command.canvas ?? '', 'canvas', 'canvas').canvas,
    );
    if (command.command === 'agents') {
      print(await call('agents', { canvas }));
      return 0;
    }
    if (command.command === 'agent' && command.action === 'add') {
      const added = await call('canvas.addAgent', {
        canvas,
        adapter: command.adapter,
        at: { x: 0, y: 0 },
        ...(command.connection === undefined ? {} : { connection: command.connection }),
        ...(role === undefined ? {} : { role }),
      });
      print(added);
      if ('proposed' in added) return 0;
      if (command.model !== undefined || command.effort !== undefined)
        print(
          await call('agent.setSettings', {
            canvas,
            agent: identifier(added.id),
            adapter: command.adapter,
            settings: settings(command),
          }),
        );
      return 0;
    }
    const agents = rows((await call('agents', { canvas })).agents);
    const agent = named(
      agents,
      command.command === 'agent' ? (command.agent ?? '') : command.to,
      'id',
      'agent',
    );
    const to = identifier(agent.id);
    if (command.command === 'agent') {
      if (command.action === 'rm') {
        print(await call('canvas.delete', { canvas, nodes: [to] }));
        return 0;
      }
      const edits: { op: OpName; args: Record<string, unknown> }[] = [];
      if (command.adapter !== undefined)
        edits.push({
          op: 'agent.setType',
          args: {
            agent: to,
            adapter: command.adapter,
            ...(command.connection === undefined ? {} : { connection: command.connection }),
          },
        });
      else if (command.connection !== undefined)
        edits.push({
          op: 'agent.setConnection',
          args: { agent: to, connection: command.connection },
        });
      if (command.model !== undefined || command.effort !== undefined) {
        const adapter = command.adapter ?? agent.adapter;
        if (typeof adapter !== 'string')
          throw invalid('Choose an agent CLI before setting its model or effort.');
        edits.push({
          op: 'agent.setSettings',
          args: { agent: to, adapter, settings: settings(command) },
        });
      }
      if (role !== undefined) edits.push({ op: 'agent.setRole', args: { agent: to, role } });
      const one = edits[0];
      if (one === undefined) throw invalid('Name the setting to change.');
      print(
        edits.length === 1
          ? await call(one.op, { canvas, ...one.args })
          : await call('canvas.batch', { canvas, ops: edits }),
      );
      return 0;
    }
    // Capture a cursor before sending: another reader of this party must not consume the reply.
    const initial = command.command === 'ask' ? await call('status', { canvas }) : undefined;
    const sent = await call('message', { canvas, to, body });
    const id = identifier(sent.id);
    if (command.command === 'send') {
      io.print(id);
      return 0;
    }
    return await awaitReply(client, { canvas, to, id, deadline, initial: initial ?? {} }, io);
  } catch (error) {
    const failure = cliFailure(error);
    print({ error: failure.error });
    return failure.exitCode;
  }
}

function settings(command: Extract<AgentCommand, { command: 'agent' }>) {
  return {
    ...(command.model === undefined ? {} : { model: command.model }),
    ...(command.effort === undefined ? {} : { effort: command.effort }),
  };
}

async function awaitReply(
  client: McpClient,
  {
    canvas,
    to,
    id,
    deadline,
    initial,
  }: { canvas: string; to: string; id: string; deadline: number; initial: Record<string, unknown> },
  io: AgentIO,
): Promise<number> {
  const now = io.now ?? (() => performance.now());
  const sleep =
    io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let after = typeof initial.next === 'string' ? initial.next : undefined;
  let told = false;
  let delay = 250;
  let first = true;
  let lastFailure: CliFailure | undefined;
  for (;;) {
    const remaining = deadline - now();
    if (!first && remaining <= 0) {
      if (lastFailure) throw lastFailure;
      return 1;
    }
    first = false;
    try {
      const status = await client.call(
        'status',
        { canvas },
        Math.max(WAIT_SLACK_MS, Math.min(60_000, remaining + WAIT_SLACK_MS)),
      );
      if (
        !told &&
        rows(status.agents).some((agent) => agent.id === to && agent.state === 'waiting')
      ) {
        io.say('Waiting for the person.');
        told = true;
      }
      const seconds = Math.max(0, Math.min(10, Math.ceil((deadline - now()) / 1000)));
      const value = await client.call(
        'wait',
        { for: id, timeoutSeconds: seconds, ...(after === undefined ? {} : { after }) },
        seconds * 1000 + WAIT_SLACK_MS,
      );
      const reply = rows(value.messages).find(
        (message) =>
          message.kind === 'text' &&
          message.from === `agent:${to}` &&
          message.replyTo === id &&
          message.turn !== undefined,
      );
      if (reply !== undefined) {
        io.print(JSON.stringify(reply));
        return 0;
      }
      if (typeof value.next === 'string') after = value.next;
      lastFailure = undefined;
      delay = 250;
    } catch (error) {
      const failure = cliFailure(error);
      if (failure.exitCode !== 3) throw failure;
      lastFailure = failure;
      const left = deadline - now();
      if (left <= 0) throw failure;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 5000);
    }
  }
}

async function brief(file: string, io: AgentIO): Promise<string> {
  const text =
    file === '-'
      ? await fromStdin(io.stdin ?? process.stdin, MAX_MESSAGE_BYTES)
      : await readText(path.resolve(io.cwd, file), MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
  if (text.length === 0) throw invalid('The brief must not be empty.');
  return text;
}
async function fromStdin(
  stream: AsyncIterable<string | Uint8Array>,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw invalid('The text exceeds its byte limit.');
    chunks.push(bytes);
  }
  return decoded(Buffer.concat(chunks));
}
function decoded(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid('The input must be UTF-8 text.');
  }
}
async function readText(file: string, limit: number, characters: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw invalid('The input must be a bounded regular text file.');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > limit) throw invalid('The input exceeds its byte limit.');
    const text = decoded(bytes.subarray(0, size));
    if (text.length > characters) throw invalid('The input exceeds its character limit.');
    return text;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw invalid('The input file could not be read.');
  } finally {
    await handle?.close();
  }
}
