import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';

it('the executable Terminal fake posts native readings before its exact handoff reply and limit failure', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-terminal-'));
  const capture = path.join(folder, 'captured.jsonl');
  const status = path.join(folder, 'status.mjs');
  const script = path.join(folder, 'script.json');
  const settings = path.join(folder, 'settings.json');
  const initialGate = path.join(folder, 'initial-release');
  const readingGate = path.join(folder, 'reading-release');
  const handoff = '# Handoff\nExact native reply.';
  const reading = (used: number) => ({
    context_window: { context_window_size: 1_000_000, used_percentage: 60 },
    rate_limits: { five_hour: { used_percentage: used } },
  });
  await writeFile(
    script,
    JSON.stringify({
      handoff,
      turns: {
        'headless-wait': { ask: true },
        'fallback-warm': { reply: 'Warm done.', reading: reading(12) },
        'fallback-limit': { fail: true, resetAfterSeconds: 60, reading: reading(100) },
      },
    }),
  );
  await writeFile(
    path.join(folder, '.fake-claude-usage.json'),
    JSON.stringify(reading(12).rate_limits),
  );
  await writeFile(
    status,
    "import {appendFileSync} from 'node:fs';let body='';for await(const part of process.stdin)body+=part;appendFileSync(process.env.CAPTURE,JSON.stringify({kind:'status',body:JSON.parse(body)})+'\\n');",
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const registration = {
    hooks: [
      { type: 'http', url: 'http://fake.invalid/hook', headers: { Authorization: 'test-hook' } },
    ],
  };
  await writeFile(
    settings,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [registration],
        Stop: [registration],
        StopFailure: [registration],
        PermissionRequest: [registration],
      },
      statusLine: { command: `${quote(process.execPath)} ${quote(status)}` },
    }),
  );
  const file = pathToFileURL(path.join(import.meta.dirname, 'fixtures/fake-terminal.mjs')).href;
  const bootstrap = `
    import {appendFileSync, existsSync} from 'node:fs';
    process.stdin.setRawMode=()=>process.stdin;
    globalThis.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);
      const status=url.toString().endsWith('/status');
      appendFileSync(process.env.CAPTURE,JSON.stringify({kind:status?'status':'hook',url: url.toString(),body})+'\\n');
      const gate=status && !body.context_window ? process.env.INITIAL_GATE
        : status && body.rate_limits?.five_hour?.used_percentage===12 ? process.env.READING_GATE : undefined;
      while(gate && !existsSync(gate)) await new Promise(resolve=>setTimeout(resolve,10));
      return new Response('{}');
    };
    process.argv=[process.execPath,'fake','--settings',process.env.SETTINGS];
    await import(process.env.FAKE_TOOL);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: folder,
    env: {
      ...process.env,
      CAPTURE: capture,
      SETTINGS: settings,
      FAKE_TOOL: file,
      FAKE_CLAUDE_FALLBACK: script,
      INITIAL_GATE: initialGate,
      READING_GATE: readingGate,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-16_384);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const ended = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  const rows = async () =>
    (await readFile(capture, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { kind: string; url?: string; body: Record<string, unknown> },
      );
  try {
    await vi.waitFor(() => {
      expect(output, errors).toContain('\x1b]7501;?');
    });
    child.stdin.write('\x1b]7501;?');
    await vi.waitFor(() => {
      expect(output, errors).toContain('state=idle');
    });
    child.stdin.write('fallback-warm\r');
    await vi.waitFor(async () => {
      expect((await rows()).some((row) => row.url === 'http://fake.invalid/status')).toBe(true);
    });
    // A first reading still in flight cannot overtake this turn's context later.
    expect((await rows()).some((row) => row.body.context_window !== undefined)).toBe(false);
    expect((await rows()).some((row) => row.body.hook_event_name === 'Stop')).toBe(false);
    await writeFile(initialGate, 'go');
    await vi.waitFor(async () => {
      expect((await rows()).some((row) => row.body.context_window !== undefined)).toBe(true);
    });
    // Receipt, not the status command's exit, gates the native turn's end.
    expect((await rows()).some((row) => row.body.hook_event_name === 'Stop')).toBe(false);
    await writeFile(readingGate, 'go');
    await vi.waitFor(async () => {
      expect(
        (await rows()).some((row) => row.body.last_assistant_message === 'Warm done.'),
        errors,
      ).toBe(true);
    });
    child.stdin.write('Your context is full, so corrallm asks you to write your handoff now.\r');
    await vi.waitFor(async () => {
      expect(
        (await rows()).some((row) => row.body.last_assistant_message === handoff),
        errors,
      ).toBe(true);
    });
    child.stdin.write('fallback-limit\r');
    await vi.waitFor(async () => {
      expect(
        (await rows()).some((row) => row.body.hook_event_name === 'StopFailure'),
        errors,
      ).toBe(true);
    });
    const captured = await rows();
    const failed = captured.findIndex((row) => row.body.hook_event_name === 'StopFailure');
    expect(captured[failed - 1]).toMatchObject({
      kind: 'status',
      body: {
        rate_limits: { five_hour: { used_percentage: 100 } },
        context_window: { used_percentage: 60 },
      },
    });
    expect(captured[failed]).toMatchObject({ kind: 'hook', body: { error: 'rate_limit' } });
    child.stdin.write('headless-wait\r');
    await vi.waitFor(async () => {
      expect(
        (await rows()).some((row) => row.body.hook_event_name === 'PermissionRequest'),
        errors,
      ).toBe(true);
    });
    expect((await rows()).filter((row) => row.body.hook_event_name === 'Stop')).toHaveLength(2);
    await vi.waitFor(() => {
      expect(output, errors).toContain('state=blocked');
    });
    expect(errors).toBe('');
  } finally {
    child.kill('SIGTERM');
    await ended;
    await rm(folder, { recursive: true, force: true });
  }
}, 15_000);

it.each(['message', 'trust'] as const)(
  'the executable Terminal fake keeps joined %s keys beside terminal probe replies',
  async (kind) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'corrallm-fallback-keys-'));
    if (kind === 'trust') await writeFile(path.join(folder, '.fake-claude-untrusted'), '');
    const file = pathToFileURL(path.join(import.meta.dirname, 'fixtures/fake-terminal.mjs')).href;
    const bootstrap = `
    process.stdin.setRawMode=()=>process.stdin;
    process.argv=[process.execPath,'fake'];
    await import(process.env.FAKE_TOOL);
  `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: folder,
      env: { ...process.env, FAKE_TOOL: file },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-16_384);
    });
    const ended = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
    const logged = async () =>
      (await readFile(path.join(folder, '.fake-claude', 'log.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; text?: string });
    try {
      await vi.waitFor(() => {
        expect(output).toContain('\x1b]7501;?');
      });
      // One read: the replies to its probes, then the first keys of a message.
      const probes = '\x1b]11;rgb:0000/0000/0000\x07\x1b[?62;4c\x1b]7501;?\x1b\\\x1b[?0u';
      child.stdin.write(probes + (kind === 'trust' ? '\x1b[B\r' : 'hello '));
      if (kind === 'trust') {
        await vi.waitFor(async () => {
          expect((await logged()).filter(({ event }) => event === 'trusted')).toHaveLength(1);
        });
        child.stdin.write('hello ');
      }
      await vi.waitFor(() => {
        expect(output).toContain('state=idle');
      });
      child.stdin.write('world\x1b[?62;4c\r');
      await vi.waitFor(async () => {
        expect(
          (await logged()).filter(({ event }) => event === 'prompt').map(({ text }) => text),
        ).toEqual(['hello world']);
      });
    } finally {
      child.kill('SIGTERM');
      await ended;
      await rm(folder, { recursive: true, force: true });
    }
  },
  15_000,
);
