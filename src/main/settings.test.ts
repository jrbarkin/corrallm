import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Settings } from './settings';

/** Whether a file's permissions can keep its owner from reading it: not on Windows, nor as root. */
const CAN_DENY = process.platform !== 'win32' && process.getuid?.() !== 0;

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-settings-'));
  file = path.join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Settings', () => {
  it('keeps the consents the user gave, by adapter, across instances (runs of the app)', async () => {
    const settings = new Settings(file);
    expect(await settings.get()).toEqual({ consents: {} });
    await settings.consent('codex', 'plan').give();
    expect(await settings.get()).toEqual({ consents: { codex: { plan: true } } });

    expect(await new Settings(file).get()).toEqual({ consents: { codex: { plan: true } } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      consents: { codex: { plan: true } },
    });
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('asks a consent only of the adapter and key it was given for', async () => {
    const settings = new Settings(file);
    const plan = settings.consent('codex', 'plan');
    expect(await plan.given()).toBe(false);
    await plan.give();
    expect(await plan.given()).toBe(true);
    expect(await settings.consent('codex', 'other').given()).toBe(false);
    expect(await settings.consent('claude-code', 'plan').given()).toBe(false);
    expect(await new Settings(file).consent('codex', 'plan').given()).toBe(true);
  });

  it('reads a file with none of the fields later versions add', async () => {
    await writeFile(file, JSON.stringify({ version: 2, consents: {} }));
    expect(await new Settings(file).get()).toEqual({ consents: {} });
    await writeFile(file, JSON.stringify({ version: 2 }));
    expect(await new Settings(file).get()).toEqual({ consents: {} });
  });

  it('starts from nothing when its file is missing, broken, of version 1, or not what it wrote', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A file it can't read as its own is set aside, as it was, and said; one of its version with
    // nothing right in it is its own, read as nothing chosen.
    for (const [text, setAside] of [
      ['not json', true],
      ['{"version": 1, "settings": {"chatgptPlan": true}}', true],
      ['[]', true],
      ['{"version": 2, "consents": []}', false],
    ] as const) {
      await rm(dir, { recursive: true });
      await mkdir(dir);
      await writeFile(file, text);
      const settings = new Settings(file);
      expect(await settings.get()).toEqual({ consents: {} });
      await settings.keepApiPort(47123);
      const rejected = (await readdir(dir)).filter((name) => name !== 'settings.json');
      expect(rejected).toEqual(
        setAside ? [expect.stringMatching(/^settings\.rejected-.+\.json$/)] : [],
      );
      if (setAside) {
        expect(await readFile(path.join(dir, String(rejected[0])), 'utf8')).toBe(text);
        expect(said).toHaveBeenLastCalledWith(
          expect.stringContaining(path.join(dir, String(rejected[0]))),
        );
      }
    }
    said.mockRestore();
    // A consent of the wrong kind, or for no adapter, is left out.
    await writeFile(
      file,
      '{"version": 2, "consents": {"codex": {"plan": "yes", "other": true}, ' +
        '"__proto__": {"plan": true}, "": {"plan": true}}}',
    );
    expect(await new Settings(file).get()).toEqual({ consents: { codex: { other: true } } });
  });

  it('keeps the port the API server listens on, so registrations survive restarts', async () => {
    const settings = new Settings(file);
    expect(await settings.apiPort()).toBeUndefined();
    await settings.consent('codex', 'plan').give();
    await settings.keepApiPort(47123);
    expect(await settings.apiPort()).toBe(47123);
    expect(await new Settings(file).apiPort()).toBe(47123);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      consents: { codex: { plan: true } },
      api: { port: 47123 },
    });
    // A port that isn't one is none.
    for (const port of [0, 65536, 1.5, '47123', null]) {
      await writeFile(file, JSON.stringify({ version: 2, consents: {}, api: { port } }));
      expect(await new Settings(file).apiPort()).toBeUndefined();
    }
  });

  it.skipIf(!CAN_DENY)(
    'never writes over a file it can’t read, and reads it again next time',
    async () => {
      const kept = `${JSON.stringify({ version: 2, consents: { codex: { plan: true } } })}\n`;
      await writeFile(file, kept);
      await chmod(file, 0);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const settings = new Settings(file);
      await expect(settings.consent('codex', 'plan').given()).rejects.toThrow(/EACCES/);
      await settings.keepApiPort(47123);
      expect(errors).toHaveBeenCalledOnce();
      errors.mockRestore();
      await chmod(file, 0o600);
      expect(await readFile(file, 'utf8')).toBe(kept);

      // Read once it can be: what it kept, and what is changed after.
      expect(await settings.consent('codex', 'plan').given()).toBe(true);
      await settings.keepApiPort(47123);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        version: 2,
        consents: { codex: { plan: true } },
        api: { port: 47123 },
      });
    },
  );

  it('writes back what a newer corrallm keeps in it that it doesn’t know, as it was', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        consents: { codex: { plan: true } },
        api: { port: 47123, host: '127.0.0.2' },
        defaultAdapter: 'codex',
      }),
    );
    const settings = new Settings(file);
    expect(await settings.get()).toEqual({
      consents: { codex: { plan: true } },
      api: { port: 47123 },
    });
    await settings.consent('claude-code', 'plan').give();
    await settings.keepApiPort(47124);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 2,
      consents: { codex: { plan: true }, 'claude-code': { plan: true } },
      api: { port: 47124, host: '127.0.0.2' },
      defaultAdapter: 'codex',
    });
  });

  it.each([
    { host: '127.0.0.2' },
    { host: '127.0.0.2', port: { number: 47123 } },
    { host: '127.0.0.2', port: '47123' },
  ])('preserves unsupported API settings on a consent write: %j', async (api) => {
    await writeFile(file, JSON.stringify({ version: 2, consents: {}, api }));
    const settings = new Settings(file);
    expect(await settings.apiPort()).toBeUndefined();
    await settings.consent('codex', 'plan').give();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ api });
    await settings.keepApiPort(47124);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      api: { host: '127.0.0.2', port: 47124 },
    });
  });

  it('reads whether OS notifications are on: absent, or not a boolean, is on (B14 C11)', async () => {
    expect(await new Settings(file).notificationsEnabled()).toBe(true);
    for (const [notifications, on] of [
      [undefined, true],
      [{ enabled: true }, true],
      [{ enabled: false }, false],
      [{ enabled: false, preview: 'names' }, false],
      [{ enabled: 'false' }, true],
      [{ enabled: 0 }, true],
      [{}, true],
      [[], true],
      ['off', true],
      [null, true],
    ] as const) {
      await writeFile(file, JSON.stringify({ version: 2, consents: {}, notifications }));
      const settings = new Settings(file);
      expect(await settings.notificationsEnabled(), JSON.stringify(notifications)).toBe(on);
      const enabled = (notifications as { enabled?: unknown } | null | undefined)?.enabled;
      expect((await settings.get()).notifications).toEqual(
        typeof enabled === 'boolean' ? { enabled } : undefined,
      );
    }
    // Another version's file is set aside, read as nothing chosen: on.
    const said = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(file, JSON.stringify({ version: 3, notifications: { enabled: false } }));
    expect(await new Settings(file).notificationsEnabled()).toBe(true);
    said.mockRestore();
  });

  it.skipIf(!CAN_DENY)('reads notifications as on from a file it can’t read', async () => {
    const kept = `${JSON.stringify({ version: 2, consents: {}, notifications: { enabled: false } })}\n`;
    await writeFile(file, kept);
    await chmod(file, 0);
    const settings = new Settings(file);
    expect(await settings.notificationsEnabled()).toBe(true);
    await chmod(file, 0o600);
    expect(await readFile(file, 'utf8')).toBe(kept);
    // Read again once it can be.
    expect(await settings.notificationsEnabled()).toBe(false);
  });

  it('writes the notifications field back as it was, with what a newer corrallm adds to it', async () => {
    for (const notifications of [
      { enabled: false },
      { enabled: true, preview: 'names' },
      { enabled: 'no', preview: 'names' },
    ]) {
      await writeFile(file, JSON.stringify({ version: 2, consents: {}, notifications }));
      const settings = new Settings(file);
      await settings.consent('codex', 'plan').give();
      await settings.keepApiPort(47123);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        version: 2,
        consents: { codex: { plan: true } },
        api: { port: 47123 },
        notifications,
      });
    }
  });

  it('applies updates in order, and a failed write fails no one', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = new Settings(path.join(dir, 'missing', 'settings.json'));
    await settings.consent('codex', 'plan').give();
    expect(errors).toHaveBeenCalledOnce();
    // What it was told stays, for this run.
    expect(await settings.consent('codex', 'plan').given()).toBe(true);
    await expect(settings.flush()).resolves.toBeUndefined();
    errors.mockRestore();
  });
});
