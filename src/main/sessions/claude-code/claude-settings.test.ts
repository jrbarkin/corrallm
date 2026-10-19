import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeOptions } from './claude-settings';

let dir: string;
let config: string;
let project: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-claude-settings-'));
  config = path.join(dir, 'config');
  project = path.join(dir, 'shop');
  await mkdir(config);
  await mkdir(path.join(project, '.claude'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (file: string, settings: unknown) =>
  writeFile(file, JSON.stringify(settings), 'utf8');
const user = (settings: unknown) => write(path.join(config, 'settings.json'), settings);
const shared = (settings: unknown) =>
  write(path.join(project, '.claude', 'settings.json'), settings);
const local = (settings: unknown) =>
  write(path.join(project, '.claude', 'settings.local.json'), settings);

const options = (env: Record<string, string> = {}) =>
  claudeOptions({ CLAUDE_CONFIG_DIR: config, ...env }, project);

describe('claudeOptions', () => {
  it('offers Claude Code’s model aliases, each with its effort levels', async () => {
    const { models, defaults } = await options();
    expect(models.map((m) => m.value)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    expect(models.find((m) => m.value === 'haiku')).toMatchObject({
      label: 'Haiku',
      description: 'Fastest for quick answers',
    });
    expect(models[0]?.efforts?.map((e) => e.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(models[0]?.efforts?.[3]).toMatchObject({ label: 'Extra high' });
    // Nothing set anywhere: the CLI's own.
    expect(defaults).toEqual({ model: null, effort: null, mode: null });
  });

  it('says the user’s own defaults, as their settings set them', async () => {
    await user({ model: 'opus', effortLevel: 'xhigh', permissions: { defaultMode: 'auto' } });
    expect((await options()).defaults).toEqual({ model: 'opus', effort: 'xhigh', mode: 'auto' });
  });

  it('reads the project’s settings over the user’s, and its local ones over both', async () => {
    await user({ model: 'opus', effortLevel: 'xhigh', permissions: { defaultMode: 'auto' } });
    await shared({ model: 'sonnet', permissions: { defaultMode: 'acceptEdits' } });
    await local({ effortLevel: 'low', permissions: { defaultMode: 'default' } });
    // 'default' is Claude Code's name for Manual.
    expect((await options()).defaults).toEqual({ model: 'sonnet', effort: 'low', mode: 'manual' });
  });

  it('takes ANTHROPIC_MODEL and CLAUDE_CODE_EFFORT_LEVEL over the settings, as Claude Code does', async () => {
    await user({ model: 'opus', effortLevel: 'xhigh', env: { ANTHROPIC_MODEL: 'fable' } });
    expect((await options()).defaults).toMatchObject({ model: 'fable', effort: 'xhigh' });
    expect(
      (await options({ ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'medium' })).defaults,
    ).toMatchObject({ model: 'haiku', effort: 'medium' });
  });

  it('offers the user’s own model too, and only the models their settings allow', async () => {
    await user({ model: 'claude-opus-4-8' });
    const own = await options();
    expect(own.models.map((m) => m.value)).toEqual([
      'opus',
      'fable',
      'sonnet',
      'haiku',
      'claude-opus-4-8',
    ]);
    expect(own.models.at(-1)).toMatchObject({ label: 'claude-opus-4-8' });

    await user({ availableModels: ['sonnet', 'haiku', 'claude-sonnet-5'] });
    expect((await options()).models.map((m) => m.value)).toEqual([
      'sonnet',
      'haiku',
      'claude-sonnet-5',
    ]);
  });

  it('passes over what it cannot read, or is not a model, an effort or a mode', async () => {
    await writeFile(path.join(config, 'settings.json'), '{ not json');
    await shared({
      model: '--dangerously-skip-permissions',
      effortLevel: 'turbo',
      permissions: { defaultMode: 'dontAsk' },
    });
    expect((await options()).defaults).toEqual({ model: null, effort: null, mode: null });
    // Theirs, whatever it is: Claude Code starts in it when corrallm passes none.
    await shared({ permissions: { defaultMode: 'bypassPermissions' } });
    expect((await options()).defaults.mode).toBe('bypassPermissions');
  });
});
