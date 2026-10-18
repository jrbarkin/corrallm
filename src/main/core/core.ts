import path from 'node:path';

import type { ConnectionId } from '../../shared/adapter';
import type { OpResult } from '../../shared/api/errors';
import { OPS } from '../../shared/api/registry';
import type { ResultOf } from '../../shared/api/registry';
import type { RULES } from '../../shared/api/rules';
import { SURFACE } from '../../shared/api/surface';
import type { OpName } from '../../shared/api/surface';
import { engineCatalog } from '../../shared/engine/catalog';
import type { SessionMode } from '../../shared/session';
import { ProjectFiles } from '../files';
import { CanvasMemory } from '../memory';
import { ProjectFolders } from '../project';
import { RunJournal } from '../run-journal';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import type { Connector } from '../sessions/connector';
import { createConnectors, createOptions } from '../sessions/connectors';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { SessionManager } from '../sessions/manager';
import { Settings } from '../settings';
import { UsageReadings } from '../usage';
import { createDispatcher } from './call';
import type { Dispatcher, RuleCheck } from './call';
import type { Caller } from './caller';
import { Engines } from './engines';
import type { HostServices } from './host';
import { implementations } from './ops';

/*
 * corrallm's core, composed: the registry's operations over the Electron-free services they act
 * on, kept in a profile folder (the app's user data, or `corrallm serve --profile`), and asking
 * whatever needs the desktop of its host. It runs each canvas it opens with an engine of its own
 * (engines.ts), whose agents' sessions its SessionManager runs in this process. In milestone 1 it
 * is composed only in tests and under `corrallm serve` (B7); B8 composes it in the app's core
 * process.
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
  /** How this build is offered: the CORRALLM_DISTRIBUTION its host was built with. */
  distribution: typeof CORRALLM_DISTRIBUTION;
  /** The locale what the core says tells times of day in (the host's): Node's own, when none. */
  locale?: string;
  /**
   * For tests: what runs agents' sessions instead of each connection's own connector
   * (sessions/fake.ts), and the environment they run in instead of the login shell's.
   */
  sessions?: {
    connectors: Readonly<Partial<Record<ConnectionId, Connector<SessionMode>>>>;
    environment: () => Promise<Readonly<Record<string, string>>>;
  };
}

export interface Core extends Dispatcher {
  call<N extends OpName>(
    name: N,
    raw: unknown,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<OpResult<ResultOf<N>>>;
  /** The canvases it runs, each with its engine. */
  engines: Engines;
  /**
   * Stops: each canvas's run held where it is and journaled, every session closed, and what the
   * core keeps written out. Rejects, once all that is done, if a run couldn't be journaled.
   */
  close(): Promise<void>;
}

/** How each rule an operation carries is checked on a token's arguments: one per RULES row. */
const RULE_CHECKS: { [R in keyof typeof RULES]: RuleCheck } = {};

export async function createCore(config: CoreConfig, host: HostServices): Promise<Core> {
  const { profile } = config;
  const usage = new UsageReadings({
    file: path.join(profile, 'usage.json'),
    backends: CATALOG.usageBackends.map((backend) => backend.id),
  });
  await usage.load();
  const memory = new CanvasMemory(path.join(profile, 'canvases.json'));
  const settings = new Settings(path.join(profile, 'settings.json'));
  const projects = new ProjectFolders({ host, memory });
  const journal = new RunJournal(path.join(profile, 'runs'), {
    memory,
    projectOf: (canvas) => projects.of(canvas),
  });
  let shell: Promise<Record<string, string>> | undefined;
  // Read once, when the first session starts.
  const environment =
    config.sessions?.environment ??
    (() => (shell ??= loginShellEnvironment().then(agentEnvironment)));
  const sessions = new SessionManager({
    catalog: CATALOG,
    connectors:
      config.sessions?.connectors ??
      createConnectors({
        fake: false,
        clientApp: `${config.app.name}/${config.app.version}`,
        distribution: config.distribution,
        consent: (adapter, key) => settings.consent(adapter, key),
        usage: (backend, windows) => {
          usage.take(backend, windows);
        },
      }),
    environment,
    options: createOptions({ fake: false }),
    projectOf: (canvas) => projects.of(canvas),
    memory,
    emit: (canvas, agentId, connection, event) => {
      engines.emit(canvas, agentId, connection, event);
    },
  });
  const engines: Engines = new Engines({
    catalog: CATALOG,
    engineCatalog: engineCatalog(CATALOG, DEFAULT_ADAPTER),
    sessions,
    projects,
    journal,
    usage,
    files: new ProjectFiles({ environment }),
    environment,
    ...(config.locale === undefined ? {} : { locale: config.locale }),
  });
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
    engines,
    close: async () => {
      try {
        await engines.close();
      } finally {
        // What the core keeps is written out even if a canvas's run couldn't be.
        await Promise.all([memory.flush(), settings.flush(), usage.flush()]);
      }
    },
  };
}
