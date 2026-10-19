import type {
  AdapterDescriptor,
  ConnectionId,
  UsageBackendDescriptor,
  UsageBackendId,
} from '../../shared/adapter';
import type { PastSession, SessionMode, SettingsOptions } from '../../shared/session';
import type { UsageWindows } from '../../shared/usage';
import type { Connector } from './connector';

/*
 * An adapter, as main's registry keeps it (adapters.ts): one per agent, from that agent's own
 * folder. What it declares to every process is its descriptor, which the catalog holds
 * (src/shared/adapter.ts); the rest is main's alone.
 */
export interface Adapter {
  readonly descriptor: AdapterDescriptor;
  /** Finds the user's executable in the agents' environment; never runs it. */
  readonly find?: (env: Readonly<Record<string, string>>) => Promise<string | undefined>;
  /** Starts each connection this adapter declares. */
  readonly connectors?: (context: ConnectorContext) => Record<ConnectionId, Connector<SessionMode>>;
  /** Reads the user's settings and choices without a session or a prompt. */
  readonly readOptions?: OptionsReader;
  /** The fake used in unpackaged test builds, shared by its connections. */
  readonly fake?: (pause: number) => Connector<SessionMode>;
  readonly fakeOptions?: SettingsOptions;
  /** Conversations the CLI keeps, when it can list and fork them. */
  readonly conversations?: Conversations;
  /** Variables belonging to a parent CLI session, never inherited by another agent. */
  readonly inheritedEnv?: readonly string[];
  /** Checks of its bundled dependencies, run by the native self-test. */
  readonly selfTests?: readonly SelfTest[];
  /** The usage backends its connections spend (each connection's `usage` names one of them). */
  readonly usageBackends: readonly UsageBackendDescriptor[];
  /**
   * Reads one of its usage backends as it is now, by a means that spends nothing (no session, no
   * model asked): its windows, or undefined if it can't say. The core asks it while the backend is
   * held at its hard limit, when no session of it runs to report the limit ending early
   * (core/usage-probe.ts). Without one, its backends are read only as its sessions report them.
   */
  readonly readUsage?: (
    backend: UsageBackendId,
    context: UsageReadContext,
  ) => Promise<UsageWindows | undefined>;
}

/** What an adapter's usage reader runs with: the agents' environment, and a folder to run in. */
export interface UsageReadContext {
  env: Readonly<Record<string, string>>;
  cwd: string;
}

/** How this build of corrallm is offered, set by CORRALLM_DISTRIBUTION when building. */
export type Distribution = 'local' | 'commercial' | 'hosted';

/** A consent only the user gives, kept by adapter and key in settings.ts. */
export interface Consent {
  given(): Promise<boolean>;
  give(): Promise<void>;
}

/** What every adapter's connectors run with. */
export interface ConnectorContext {
  clientApp: string;
  distribution: Distribution;
  consent: (key: string) => Consent;
  usage?: (backend: UsageBackendId, windows: UsageWindows) => void;
}

/** Reads an adapter's choices in a folder, in the agents' environment. */
export type OptionsReader = (context: UsageReadContext) => Promise<SettingsOptions>;

/** A conversation the CLI keeps for a folder, before the manager marks the agent's own. */
export type KeptConversation = Omit<PastSession, 'current'>;

export interface Conversations {
  list(folder: string): Promise<KeptConversation[]>;
  before(folder: string, sessionId: string, messageId: string): Promise<string | null>;
  fork(folder: string, sessionId: string, upTo: string): Promise<string>;
}

/** A bundled dependency's check: what it saw, or a rejection saying what failed. */
export interface SelfTest {
  name: string;
  run(): Promise<string>;
}
