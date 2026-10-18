import { askAppServer, startAppServer } from '../rpc';
import type { AppServer, AppServerOptions } from '../rpc';
import { computedTrust, hookOverrides } from './hooks';
import type { SessionHook } from './hooks';

/*
 * Trusting a Codex Terminal session's own hooks (hooks.ts) for that session alone. Codex trusts a
 * hook by its key and a hash of what it runs; corrallm computes both as Codex 0.160 does, and, once
 * per Codex (each executable and version), asks Codex itself what they are: a private
 * `codex app-server` given the same hooks lists them (hooks/list), with the key and hash it
 * trusts each by. Where they agree, the computed ones are used from then on; where they do not (a
 * newer Codex hashing otherwise, or Windows' keys), Codex's own are, and Codex is asked again for
 * every session. Without them, its TUI would stop at "Hooks need review", whose "Trust all" would
 * write to the user's config.toml.
 */

/** The trust a session's hooks need: each hook's key, and the hash trusted for it. */
export type HookTrust = ReadonlyMap<string, string>;

/** How long Codex may take to list its hooks before the computed trust is used. */
const LIST_MS = 15_000;

/** Whether the computed trust held for a Codex (its executable and version): see `HookTruster`. */
type Verdict = 'computed' | 'listed';

export interface HookTrusterOptions {
  /** Starts Codex's app server (rpc.ts; a fake in tests). */
  start?: (options: AppServerOptions) => Promise<AppServer>;
  /** What the server is told runs it. */
  clientInfo?: AppServerOptions['clientInfo'];
  listMs?: number;
}

/** What a Codex is, and where it runs, for asking it about hooks. */
export interface TrustContext {
  codex: string;
  version: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

/** Finds the trust a session's hooks need, asking each Codex once whether corrallm computes it right. */
export class HookTruster {
  readonly #start: (options: AppServerOptions) => Promise<AppServer>;
  readonly #clientInfo: AppServerOptions['clientInfo'];
  readonly #listMs: number;
  readonly #verdicts = new Map<string, Verdict>();

  constructor({
    start = startAppServer,
    clientInfo = { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
    listMs = LIST_MS,
  }: HookTrusterOptions = {}) {
    this.#start = start;
    this.#clientInfo = clientInfo;
    this.#listMs = listMs;
  }

  async trust(hooks: readonly SessionHook[], context: TrustContext): Promise<HookTrust> {
    const computed = computedTrust(hooks);
    const which = `${context.codex}\0${context.version}`;
    if (this.#verdicts.get(which) === 'computed') return computed;
    const listed = await this.#list(hooks, context).catch(() => undefined);
    // Codex could not say: the computed trust is the best there is (asked again next time).
    if (listed?.size !== hooks.length) return computed;
    const same = [...computed].every(([key, hash]) => listed.get(key) === hash);
    this.#verdicts.set(which, same ? 'computed' : 'listed');
    return same ? computed : listed;
  }

  /** What Codex says of the hooks: each one's key and hash, as it trusts them. */
  async #list(hooks: readonly SessionHook[], context: TrustContext): Promise<Map<string, string>> {
    const result = await askAppServer(
      {
        codex: context.codex,
        cwd: context.cwd,
        env: context.env,
        clientInfo: this.#clientInfo,
        args: hookOverrides(hooks).flatMap((override) => ['-c', override]),
      },
      (server) => server.request('hooks/list', { cwds: [context.cwd] }),
      { start: this.#start, ms: this.#listMs, slow: 'Codex took too long to list its hooks.' },
    );
    return sessionHooksListed(result, hooks);
  }
}

/**
 * The keys and hashes of a session's hooks in what hooks/list answered (`{ data: [{ hooks: [{ key,
 * source, command, currentHash }] }] }`): those passed on the command line (source sessionFlags)
 * that run one of `hooks`' commands.
 */
export function sessionHooksListed(
  result: unknown,
  hooks: readonly SessionHook[],
): Map<string, string> {
  const commands = new Set(hooks.map((hook) => hook.command));
  const listed = new Map<string, string>();
  const array = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
  const record = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  for (const entry of array(record(result).data)) {
    for (const hook of array(record(entry).hooks)) {
      const { key, source, command, currentHash } = record(hook);
      if (
        source === 'sessionFlags' &&
        typeof key === 'string' &&
        typeof command === 'string' &&
        commands.has(command) &&
        typeof currentHash === 'string'
      ) {
        listed.set(key, currentHash);
      }
    }
  }
  return listed;
}
