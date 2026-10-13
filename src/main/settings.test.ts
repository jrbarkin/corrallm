import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planConsent, Settings } from './settings';

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
  it('keeps what the user chose for the app, across instances (runs of the app)', async () => {
    const settings = new Settings(file);
    expect(await settings.get()).toEqual({});
    await settings.update((s) => ({ ...s, chatgptPlan: true }));
    expect(await settings.get()).toEqual({ chatgptPlan: true });

    expect(await new Settings(file).get()).toEqual({ chatgptPlan: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      settings: { chatgptPlan: true },
    });
    // Written whole: nothing is left beside it.
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('starts from nothing when its file is missing, unreadable, or not what it wrote', async () => {
    for (const text of ['not json', '{"version": 2, "settings": {"chatgptPlan": true}}', '[]']) {
      await writeFile(file, text);
      expect(await new Settings(file).get()).toEqual({});
    }
    // A setting of the wrong kind is left out.
    await writeFile(file, '{"version": 1, "settings": {"chatgptPlan": "yes"}}');
    expect(await new Settings(file).get()).toEqual({});
  });

  it('applies updates in order, and a failed write fails no one', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = new Settings(path.join(dir, 'missing', 'settings.json'));
    await settings.update((s) => ({ ...s, chatgptPlan: true }));
    expect(errors).toHaveBeenCalledOnce();
    // What it was told stays, for this run.
    expect(await settings.get()).toEqual({ chatgptPlan: true });
    await expect(settings.flush()).resolves.toBeUndefined();
    errors.mockRestore();
  });

  it('keeps the user’s say on Codex using their ChatGPT plan', async () => {
    const consent = planConsent(new Settings(file));
    expect(await consent.given()).toBe(false);
    await consent.give();
    expect(await consent.given()).toBe(true);
    expect(await planConsent(new Settings(file)).given()).toBe(true);
  });
});
