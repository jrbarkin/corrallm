import path from 'node:path';

import type { OpResult } from '../../shared/api/errors';
import { OPS } from '../../shared/api/registry';
import type { ResultOf } from '../../shared/api/registry';
import type { RULES } from '../../shared/api/rules';
import { SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import { CATALOG } from '../sessions/adapters';
import { UsageReadings } from '../usage';
import { createDispatcher } from './call';
import type { Dispatcher, RuleCheck } from './call';
import type { Caller } from './caller';
import type { HostServices } from './host';
import { implementations } from './ops';

/*
 * corrallm's core, composed: the registry's operations over the Electron-free services they act
 * on, kept in a profile folder (the app's user data, or `corrallm serve --profile`), and asking
 * whatever needs the desktop of its host. In milestone 1 it is composed only in tests and under
 * `corrallm serve` (B7); B8 composes it in the app's core process.
 */

export interface CoreConfig {
  /** The profile folder, where the core keeps its stores. */
  profile: string;
  /** Which app this is, as app.info says. */
  app: { name: string; version: string };
  /**
   * Whether every call's arguments and result are checked to be plain data, and every result
   * against its schema: in dev and tests (CoreLink checks what crosses a port the same way).
   */
  check: boolean;
}

export interface Core extends Dispatcher {
  call<N extends OpName>(
    name: N,
    raw: unknown,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<OpResult<ResultOf<N>>>;
  /** Writes out what the core keeps, before it exits. */
  close(): Promise<void>;
}

/** How each rule an operation carries is checked on a token's arguments: one per RULES row. */
const RULE_CHECKS: { [R in keyof typeof RULES]: RuleCheck } = {};

export async function createCore(config: CoreConfig, host: HostServices): Promise<Core> {
  const usage = new UsageReadings({
    file: path.join(config.profile, 'usage.json'),
    backends: CATALOG.usageBackends.map((backend) => backend.id),
  });
  await usage.load();
  const dispatcher = createDispatcher(
    {
      surface: SURFACE,
      ops: OPS,
      implementations: implementations({ app: config.app, usage, host }),
      rules: RULE_CHECKS,
    },
    { check: config.check },
  );
  return {
    surface: dispatcher.surface,
    ops: dispatcher.ops,
    partyOf: (caller) => dispatcher.partyOf(caller),
    call: <N extends OpName>(name: N, raw: unknown, caller: Caller, signal?: AbortSignal) =>
      dispatcher.call(name, raw, caller, signal) as Promise<OpResult<ResultOf<N>>>,
    close: () => usage.flush(),
  };
}
