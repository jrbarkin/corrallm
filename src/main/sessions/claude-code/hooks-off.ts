import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { HOOK_TOKEN } from '../terminal/hooks';

/*
 * Whether the user's or their organization's Claude Code settings turn off the hooks corrallm
 * listens to (hooks.ts), read when a Terminal session starts from the settings files Claude Code
 * reads (never written): its managed settings (the organization's: managed-settings.json and
 * managed-settings.d/ in the OS's folder for them), then the project folder's local and shared
 * settings, then the user's. Then corrallm can't hear its replies (its Stop hook), so the queues'
 * Run can't read them, and the session says so. What they turn off:
 *
 * - disableAllHooks: every hook and the status line (so no usage readings either), as set by the
 *   most particular settings that set it (managed, then local, project, user);
 * - allowManagedHooksOnly, or strictPluginOnlyCustomization locking hooks (managed settings only):
 *   hooks other than the organization's and its plugins';
 * - allowedHttpHookUrls (lists merge across settings) without a pattern for corrallm's hook
 *   server, on 127.0.0.1;
 * - httpHookAllowedEnvVars (merged too) without its token's variable, which its hooks send.
 *
 * Not read: managed settings from a server or an OS policy (a macOS profile, the Windows registry).
 */

/** A setting that keeps corrallm's hooks from posting to it. */
export type HooksSetting =
  | 'disableAllHooks'
  | 'allowManagedHooksOnly'
  | 'strictPluginOnlyCustomization'
  | 'allowedHttpHookUrls'
  | 'httpHookAllowedEnvVars';

/** What turns corrallm's hooks off: the setting, where it is set, and whether the status line too. */
export interface HooksOff {
  setting: HooksSetting;
  /** The settings file, as the user knows it, or the organization's managed settings. */
  where: string;
  /** Whether Claude Code runs no status line either (no usage readings). */
  statusLine: boolean;
}

/** The folder Claude Code reads its managed settings from, on each OS. */
export function managedSettingsFolder(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return path.join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode');
  return '/etc/claude-code';
}

const MANAGED = 'your organization’s managed settings';

/** A settings file read: where it is (as the user knows it), whether managed, what it says. */
interface Source {
  where: string;
  managed: boolean;
  settings: Readonly<Record<string, unknown>>;
}

export interface HooksOffOptions {
  /** The project folder. */
  cwd: string;
  /** The agents' environment: where the user's settings are (CLAUDE_CONFIG_DIR, HOME). */
  env: Readonly<Record<string, string>>;
  /** The managed settings' folder (managedSettingsFolder()). */
  managed: string;
  /** Where corrallm's hooks post. */
  url: string;
}

/** What turns corrallm's hooks off for a session in `cwd`, if anything does. */
export async function hooksOff({
  cwd,
  env,
  managed,
  url,
}: HooksOffOptions): Promise<HooksOff | undefined> {
  const sources = await settingsSources(cwd, env, managed);
  const first = (setting: string, from = sources) =>
    from.find((source) => typeof source.settings[setting] === 'boolean');
  const disabled = first('disableAllHooks');
  if (disabled?.settings.disableAllHooks === true) {
    return { setting: 'disableAllHooks', where: disabled.where, statusLine: true };
  }
  const policies = sources.filter((source) => source.managed);
  if (first('allowManagedHooksOnly', policies)?.settings.allowManagedHooksOnly === true) {
    return { setting: 'allowManagedHooksOnly', where: MANAGED, statusLine: false };
  }
  const strict = policies.find((source) => 'strictPluginOnlyCustomization' in source.settings);
  const locked = strict?.settings.strictPluginOnlyCustomization;
  if (locked === true || (Array.isArray(locked) && locked.includes('hooks'))) {
    return { setting: 'strictPluginOnlyCustomization', where: MANAGED, statusLine: false };
  }
  const urls = merged(sources, 'allowedHttpHookUrls');
  if (urls && !urls.values.some((pattern) => matches(pattern, url))) {
    return { setting: 'allowedHttpHookUrls', where: urls.where, statusLine: false };
  }
  const vars = merged(sources, 'httpHookAllowedEnvVars');
  if (vars && !vars.values.includes(HOOK_TOKEN)) {
    return { setting: 'httpHookAllowedEnvVars', where: vars.where, statusLine: false };
  }
  return undefined;
}

/** What the session tells the user when its hooks are off: which setting, where, what won't work. */
export function hooksOffWarning({ setting, where, statusLine }: HooksOff): string {
  const whose = setting === 'disableAllHooks' ? 'its' : 'corrallm’s';
  return (
    `Claude Code’s settings turn off ${whose} hooks (${setting} in ${where}), so corrallm can’t ` +
    'hear this agent’s replies: in a run, “the output contains” and conditions in your words ' +
    `see no reply, and its steps count as succeeded.${statusLine ? ' Its usage isn’t read either.' : ''}`
  );
}

/**
 * The settings files Claude Code reads, the most particular first: managed (its drop-ins, then
 * its file), local, project, user. Files that can't be read, or aren't a JSON object, are left out.
 */
async function settingsSources(
  cwd: string,
  env: Readonly<Record<string, string>>,
  managed: string,
): Promise<Source[]> {
  const home = env.HOME ?? homedir();
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  const dropIns = await readdir(path.join(managed, 'managed-settings.d')).then(
    (names) =>
      names
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .sort()
        .reverse()
        .map((name) => path.join(managed, 'managed-settings.d', name)),
    () => [],
  );
  const files: { file: string; where: string; managed: boolean }[] = [
    ...[...dropIns, path.join(managed, 'managed-settings.json')].map((file) => ({
      file,
      where: MANAGED,
      managed: true,
    })),
    ...['settings.local.json', 'settings.json'].map((name) => ({
      file: path.join(cwd, '.claude', name),
      where: `the project’s ${path.join('.claude', name)}`,
      managed: false,
    })),
    {
      file: path.join(config, 'settings.json'),
      where: shown(path.join(config, 'settings.json'), home),
      managed: false,
    },
  ];
  const read = await Promise.all(
    files.map(async ({ file, where, managed: isManaged }): Promise<Source | undefined> => {
      try {
        const settings: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
          return undefined;
        }
        return { where, managed: isManaged, settings: settings as Record<string, unknown> };
      } catch {
        return undefined;
      }
    }),
  );
  return read.filter((source) => source !== undefined);
}

/** A list setting merged across the settings that set it, and the first of them; none if unset. */
function merged(
  sources: readonly Source[],
  setting: string,
): { values: string[]; where: string } | undefined {
  const setIn = sources.filter((source) => Array.isArray(source.settings[setting]));
  const [first] = setIn;
  if (!first) return undefined;
  const values = setIn.flatMap((source) => {
    const list = source.settings[setting];
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  });
  return { values, where: first.where };
}

/** Whether `url` matches an allowedHttpHookUrls pattern: `*` matches anything, the rest is exact. */
function matches(pattern: string, url: string): boolean {
  if (pattern === '*') return true;
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'i').test(url);
}

/** A file in the home folder as ~/…. */
function shown(file: string, home: string): string {
  const relative = path.relative(home, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? path.join('~', relative)
    : file;
}
