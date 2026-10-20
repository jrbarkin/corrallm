import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { EFFORT_PATTERN, MODEL_PATTERN } from '../../../shared/session';
import type { ModelChoice, SettingsOptions } from '../../../shared/session';
import { CLAUDE_EFFORTS, effortChoice } from './efforts';
import { corrallmMode } from './sdk/translate';

/*
 * What a Claude agent can be set to run with, as far as corrallm can tell without a prompt or a
 * session: a Claude · Terminal agent's CLI runs only in its terminal, whose /model picker is
 * Claude Code's own (and saving there would change the user's default), and on a Claude
 * subscription corrallm never runs it through the Agent SDK, where its init would list models.
 * So the models are the aliases `claude --model` takes for the latest of each family (as its
 * --help says; described in Claude Code's own words, from 2.1.296's model list), restricted to the
 * user's `availableModels` where their settings set one, with the user's own model if it is none
 * of them; each with its native effort levels (`--effort`). The user's own defaults are read from
 * their settings as Claude Code reads them (the project's local settings, then its shared ones,
 * then the user's, in CLAUDE_CONFIG_DIR or ~/.claude: `model`, `effortLevel`,
 * `permissions.defaultMode`), with ANTHROPIC_MODEL and CLAUDE_CODE_EFFORT_LEVEL (the agents'
 * environment, or a settings file's `env`) over them, as in Claude Code; and whether the mode it
 * starts in asks before acting (not told for a mode corrallm doesn't know), which holds parties'
 * messages to an agent that would start in one that doesn't (core/delivery/delivery.ts). Nothing
 * is written, and nothing run. Not read: managed (policy) settings.
 */

/** The aliases `claude --model` takes, in the order Claude Code lists them. */
const ALIASES: readonly { value: string; label: string; description: string }[] = [
  { value: 'opus', label: 'Opus', description: 'For complex work and everyday tasks' },
  { value: 'fable', label: 'Fable', description: 'For your toughest challenges' },
  { value: 'sonnet', label: 'Sonnet', description: 'Most efficient for simpler tasks' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest for quick answers' },
];

/** Claude Code's effort levels, as its pickers offer them. */
const EFFORTS = Object.keys(CLAUDE_EFFORTS).map(effortChoice);

type Settings = Record<string, unknown>;

/**
 * What a Claude agent can be set to run with, in project folder `cwd`, for an agent in `env` (the
 * agents' environment): see above.
 */
export async function claudeOptions(
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<SettingsOptions> {
  // Most important first.
  const files = await Promise.all(
    [
      path.join(cwd, '.claude', 'settings.local.json'),
      path.join(cwd, '.claude', 'settings.json'),
      path.join(
        env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? homedir(), '.claude'),
        'settings.json',
      ),
    ].map(readSettings),
  );
  /** What the most important file that says it says. */
  const first = <T>(read: (settings: Settings) => T | undefined): T | undefined =>
    files.map(read).find((value) => value !== undefined);
  const variable = (name: string) =>
    env[name] ?? first((settings) => text(record(settings.env)?.[name]));
  const model = [variable('ANTHROPIC_MODEL'), first((settings) => text(settings.model))].find(
    (value) => value !== undefined,
  );
  const effort = [
    variable('CLAUDE_CODE_EFFORT_LEVEL'),
    first((settings) => text(settings.effortLevel)),
  ].find((value) => value !== undefined);
  const mode = first((settings) => corrallmMode(record(settings.permissions)?.defaultMode));
  // Whether the mode it starts in asks: the one the most particular settings that name one name
  // (none: Claude Code's own, Manual), unless corrallm doesn't know it.
  const named = first((settings) => text(record(settings.permissions)?.defaultMode));
  const starts = named === undefined ? 'manual' : corrallmMode(named);
  const available = first((settings) =>
    Array.isArray(settings.availableModels)
      ? settings.availableModels.filter(
          (one): one is string => typeof one === 'string' && MODEL_PATTERN.test(one),
        )
      : undefined,
  );

  const own = model !== undefined && MODEL_PATTERN.test(model) ? model : null;
  const values = [
    ...ALIASES.map((alias) => alias.value).filter((alias) => available?.includes(alias) ?? true),
    ...(available ?? []),
    ...(own === null || own === 'default' ? [] : [own]),
  ];
  const models = [...new Set(values)].map((value): ModelChoice => ({
    ...(ALIASES.find((alias) => alias.value === value) ?? { value, label: value }),
    efforts: EFFORTS,
  }));
  return {
    models,
    defaults: {
      model: own === 'default' ? null : own,
      effort:
        effort !== undefined && EFFORT_PATTERN.test(effort) && Object.hasOwn(CLAUDE_EFFORTS, effort)
          ? effort
          : null,
      mode: mode ?? null,
      ...(starts === undefined ? {} : { asks: starts !== 'bypassPermissions' }),
    },
  };
}

/** A settings file's settings, or {} if it cannot be read. */
async function readSettings(file: string): Promise<Settings> {
  try {
    return record(JSON.parse(await readFile(file, 'utf8'))) ?? {};
  } catch {
    return {};
  }
}

function record(value: unknown): Settings | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Settings)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
