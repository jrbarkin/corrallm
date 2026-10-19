import type {
  AdapterDescriptor,
  UsageBackendDescriptor,
  UsageBackendId,
} from '../../shared/adapter';
import type { UsageWindows } from '../../shared/usage';

/*
 * An adapter, as main's registry keeps it (adapters.ts): one per agent, from that agent's own
 * folder. What it declares to every process is its descriptor, which the catalog holds
 * (src/shared/adapter.ts); the rest is main's alone.
 */
export interface Adapter {
  readonly descriptor: AdapterDescriptor;
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
