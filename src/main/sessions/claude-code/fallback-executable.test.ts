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
  const bootstrap =
    "import {appendFileSync} from 'node:fs';process.stdin.setRawMode=()=>process.stdin;globalThis.fetch=async(_url,options)=>{appendFileSync(process.env.CAPTURE,JSON.stringify({kind:'hook',body:JSON.parse(options.body)})+'\\n');return new Response('{}');};process.argv=[process.execPath,'fake','--settings',process.env.SETTINGS];await import(process.env.FAKE_TOOL);";
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: folder,
    env: {
      ...process.env,
      CAPTURE: capture,
      SETTINGS: settings,
      FAKE_TOOL: file,
      FAKE_CLAUDE_FALLBACK: script,
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
      .map((line) => JSON.parse(line) as { kind: string; body: Record<string, unknown> });
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
