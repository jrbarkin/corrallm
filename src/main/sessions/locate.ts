import path from 'node:path';

import { ID_PATTERN } from '../../shared/adapter';
import type { Adapter } from './adapter';
import { canRun } from './executables';

/** Unset/empty discovers normally; any JSON map, including {}, is an exclusive allowlist. */
export function parseAgentPaths(
  value: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === '') return undefined;
  const fail = () =>
    new TypeError(
      'CORRALLM_AGENT_PATHS must be a JSON object mapping adapter ids to absolute executable paths.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw fail();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail();
  const entries = Object.entries(parsed);
  for (const [id, file] of entries) {
    if (
      !ID_PATTERN.test(id) ||
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      /\p{Cc}/u.test(file)
    )
      throw fail();
  }
  return Object.fromEntries(entries);
}

interface Located {
  override: string | undefined;
  found: Promise<string | undefined>;
  /** What `found` resolved to, once it has: only ever an executable that was found. */
  file?: string;
}

const located = new WeakMap<Readonly<Record<string, string>>, Map<Adapter, Located>>();

/**
 * An adapter's executable in the agents' environment. A search in progress is shared, and one that
 * found an executable is kept while it can still run; a miss or a failed search is not kept, so
 * a CLI installed, or moved, after one is found by the next. Adapters never perform discovery.
 */
export function locate(
  adapter: Adapter,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const override = process.env.CORRALLM_AGENT_PATHS;
  const paths = parseAgentPaths(override);
  const cache = located.get(env) ?? new Map<Adapter, Located>();
  located.set(env, cache);
  const old = cache.get(adapter);
  if (old !== undefined && old.override === override) {
    const kept = old.file;
    if (kept === undefined) return old.found;
    return canRun(kept).then((runs) => {
      if (runs) return kept;
      if (cache.get(adapter) === old) cache.delete(adapter);
      return locate(adapter, env);
    });
  }
  const file = paths?.[adapter.descriptor.id];
  const found =
    paths === undefined
      ? (adapter.find?.(env) ?? Promise.resolve(undefined))
      : file === undefined
        ? Promise.resolve(undefined)
        : canRun(file).then((runs) => (runs ? file : undefined));
  const entry: Located = { override, found };
  const forget = () => {
    if (cache.get(adapter) === entry) cache.delete(adapter);
  };
  cache.set(adapter, entry);
  found.then((executable) => {
    if (executable === undefined) forget();
    else entry.file = executable;
  }, forget);
  return found;
}

/** A connector or reader that needs an executable gets a sentence rather than another search. */
export async function requireLocated(
  adapter: Adapter,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const file = await locate(adapter, env);
  if (file === undefined)
    throw new Error(
      `${adapter.descriptor.name} isn't installed, or corrallm can't find it. Install it and log in with its CLI, then try again.`,
    );
  return file;
}
