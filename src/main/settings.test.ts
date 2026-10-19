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
