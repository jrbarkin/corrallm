import { EFFORT_PATTERN, MODEL_PATTERN } from '../../../shared/session';
import type { CodexMode, ModelChoice, SettingsOptions } from '../../../shared/session';
import { property, text } from '../transcript';
import { readModels } from './app-server/session';
import { askAppServer, startAppServer } from './rpc';
import type { AppServer, AppServerOptions } from './rpc';
import { folderTrust } from './terminal/hooks';

/*
 * What a Codex agent can be set to run with, without a session: a private `codex app-server` (the
 * user's own `codex`, in the project folder, trusted for that server alone as a Codex Terminal
 * session trusts it) is asked only `model/list` (the models its pickers offer, with their
 * reasoning efforts) and `config/read` (the user's effective config.toml, the project's included:
 * their default model, effort, sandbox and approvals), then closed. No thread starts and no model
 * is asked anything, so it spends no usage and needs no consent on a ChatGPT plan. Nothing is
 * written.
 */

/** How long Codex may take to answer before corrallm gives up asking. */
const ASK_MS = 15_000;

/** What a `codex` is, and where it runs. */
export interface OptionsContext {
  codex: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export async function codexOptions(
  context: OptionsContext,
  {
    start = startAppServer,
    ms = ASK_MS,
  }: { start?: (options: AppServerOptions) => Promise<AppServer>; ms?: number } = {},
): Promise<SettingsOptions> {
  const [listed, read] = await askAppServer(
    {
      ...context,
      clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
      args: ['-c', folderTrust(context.cwd)],
    },
    (server) =>
      Promise.all([
        server.request('model/list', { limit: 100 }),
        server.request('config/read', { cwd: context.cwd }).catch(() => undefined),
      ]),
    { start, ms, slow: 'Codex took too long to list its models.' },
  ).catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex could not list its models: ${why}`, { cause: error });
  });
  const config = property(read, 'config');
  const data = property(listed, 'data');
  const fallback = Array.isArray(data)
    ? text(
        property(
          data.find((model) => property(model, 'isDefault') === true),
          'model',
        ),
      )
    : undefined;
  const model = text(property(config, 'model')) ?? fallback;
  const effort = text(property(config, 'model_reasoning_effort'));
  return {
    models: readModels(listed).map(
      ({ value, label, description, efforts, defaultEffort }): ModelChoice => ({
        value,
        label,
        ...(description === undefined ? {} : { description }),
        ...(efforts === undefined ? {} : { efforts }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      }),
    ),
    defaults: {
      model: model !== undefined && MODEL_PATTERN.test(model) ? model : null,
      effort: effort !== undefined && EFFORT_PATTERN.test(effort) ? effort : null,
      mode: presetOf(property(config, 'sandbox_mode'), property(config, 'approval_policy')),
    },
  };
}

/**
 * Which of Codex's /permissions presets a config's sandbox and approvals are, or null for none of
 * them. Neither set is Codex's Default.
 */
function presetOf(sandbox: unknown, approvals: unknown): CodexMode | null {
  if (sandbox === 'read-only') return 'read-only';
  if (sandbox === 'danger-full-access') return approvals === 'never' ? 'full-access' : null;
  return approvals === null || approvals === undefined || approvals === 'on-request'
    ? 'auto'
    : null;
}
