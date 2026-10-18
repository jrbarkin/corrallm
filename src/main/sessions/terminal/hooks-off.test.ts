import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOOK_TOKEN } from './hooks';
import { hooksOff, hooksOffWarning } from './hooks-off';

const URL = 'http://127.0.0.1:52817/hook';

let dir: string;
/** The user's home, the project folder and the managed settings' folder, in `dir`. */
let home: string;
let cwd: string;
let managed: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-hooks-off-'));
  home = path.join(dir, 'home');
  cwd = path.join(dir, 'app');
  managed = path.join(dir, 'managed');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a settings file (JSON, or text as it is). */
async function settings(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const user = (value: unknown) => settings(path.join(home, '.claude', 'settings.json'), value);
const project = (value: unknown) => settings(path.join(cwd, '.claude', 'settings.json'), value);
const local = (value: unknown) => settings(path.join(cwd, '.claude', 'settings.local.json'), value);
const policy = (value: unknown, file = 'managed-settings.json') =>
  settings(path.join(managed, file), value);

/** What turns corrallm's hooks off, as the settings are now. */
const off = () => hooksOff({ cwd, env: { HOME: home }, managed, url: URL });

describe('Claude Code settings that turn corrallm’s hooks off', () => {
  it('finds none where nothing turns them off, or the files cannot be read', async () => {
    await expect(off()).resolves.toBeUndefined();
    await user('{ not json');
    await project({ disableAllHooks: false, allowedHttpHookUrls: ['http://127.0.0.1:*'] });
    await local({ httpHookAllowedEnvVars: [HOOK_TOKEN, 'OTHER'] });
    await expect(off()).resolves.toBeUndefined();
  });

  it('finds disableAllHooks as Claude Code reads it: the most particular setting wins', async () => {
    await user({ disableAllHooks: true });
    await expect(off()).resolves.toEqual({
      setting: 'disableAllHooks',
      where: path.join('~', '.claude', 'settings.json'),
      statusLine: true,
    });
    await project({ disableAllHooks: false });
    await expect(off()).resolves.toBeUndefined();
    await local({ disableAllHooks: true });
    await expect(off()).resolves.toMatchObject({
      where: `the project’s ${path.join('.claude', 'settings.local.json')}`,
    });
    // The organization's managed settings win over all.
    await policy({ disableAllHooks: false });
    await expect(off()).resolves.toBeUndefined();
  });

  it('finds the organization allowing only its own hooks, or only plugins’', async () => {
    // Read from managed settings only.
    await user({ allowManagedHooksOnly: true });
    await expect(off()).resolves.toBeUndefined();
    await policy({ allowManagedHooksOnly: true });
    await expect(off()).resolves.toEqual({
      setting: 'allowManagedHooksOnly',
      where: 'your organization’s managed settings',
      statusLine: false,
    });
    await policy({});
    await policy(
      { strictPluginOnlyCustomization: ['skills', 'hooks'] },
      'managed-settings.d/10.json',
    );
    await expect(off()).resolves.toMatchObject({ setting: 'strictPluginOnlyCustomization' });
    await policy({ strictPluginOnlyCustomization: ['skills'] }, 'managed-settings.d/10.json');
    await expect(off()).resolves.toBeUndefined();
  });

  it('finds the addresses hooks may post to leaving out 127.0.0.1’s', async () => {
    await user({ allowedHttpHookUrls: ['https://hooks.example.com/*'] });
    await expect(off()).resolves.toMatchObject({ setting: 'allowedHttpHookUrls' });
    // Lists merge across settings: one that allows corrallm's is enough.
    await project({ allowedHttpHookUrls: ['http://127.0.0.1:*/*'] });
    await expect(off()).resolves.toBeUndefined();
    await project({ allowedHttpHookUrls: ['http://localhost:*/*'] });
    await expect(off()).resolves.toMatchObject({ setting: 'allowedHttpHookUrls' });
    await user({});
    await project({ allowedHttpHookUrls: [] });
    await expect(off()).resolves.toMatchObject({
      where: `the project’s ${path.join('.claude', 'settings.json')}`,
    });
  });

  it('finds the token kept out of corrallm’s hooks', async () => {
    await policy({ httpHookAllowedEnvVars: ['OTHER_TOKEN'] });
    await expect(off()).resolves.toEqual({
      setting: 'httpHookAllowedEnvVars',
      where: 'your organization’s managed settings',
      statusLine: false,
    });
    await user({ httpHookAllowedEnvVars: [HOOK_TOKEN] });
    await expect(off()).resolves.toBeUndefined();
  });
});

describe('the warning', () => {
  it('says which setting, where, and what won’t work', () => {
    expect(
      hooksOffWarning({
        setting: 'disableAllHooks',
        where: path.join('~', '.claude', 'settings.json'),
        statusLine: true,
      }),
    ).toBe(
      `Claude Code’s settings turn off its hooks (disableAllHooks in ${path.join('~', '.claude', 'settings.json')}), ` +
        'so corrallm can’t hear this agent’s replies: in a run, “the output contains” and ' +
        'conditions in your words see no reply, and its steps count as succeeded. Its usage isn’t ' +
        'read either.',
    );
    expect(
      hooksOffWarning({
        setting: 'allowedHttpHookUrls',
        where: 'your organization’s managed settings',
        statusLine: false,
      }),
    ).toBe(
      'Claude Code’s settings turn off corrallm’s hooks (allowedHttpHookUrls in your ' +
        'organization’s managed settings), so corrallm can’t hear this agent’s replies: in a ' +
        'run, “the output contains” and conditions in your words see no reply, and its steps ' +
        'count as succeeded.',
    );
  });
});
