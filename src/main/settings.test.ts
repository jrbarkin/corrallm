import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Settings } from './settings';

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

  it('starts from nothing when its file is missing, unreadable, of version 1, or not what it wrote', async () => {
    for (const text of [
      'not json',
      '{"version": 1, "settings": {"chatgptPlan": true}}',
      '[]',
      '{"version": 2, "consents": []}',
    ]) {
      await writeFile(file, text);
      expect(await new Settings(file).get()).toEqual({ consents: {} });
    }
    // A consent of the wrong kind, or for no adapter, is left out.
    await writeFile(
      file,
      '{"version": 2, "consents": {"codex": {"plan": "yes", "other": true}, ' +
        '"__proto__": {"plan": true}, "": {"plan": true}}}',
    );
    expect(await new Settings(file).get()).toEqual({ consents: { codex: { other: true } } });
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
