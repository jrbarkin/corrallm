import type { AdapterDescriptor, UsageBackendDescriptor } from '../../shared/adapter';

/*
 * An adapter, as main's registry keeps it (adapters.ts): one per agent, from that agent's own
 * folder. What it declares to every process is its descriptor, which the catalog holds
 * (src/shared/adapter.ts); the rest is main's alone.
 */
export interface Adapter {
  readonly descriptor: AdapterDescriptor;
  /** The usage backends its connections spend (each connection's `usage` names one of them). */
  readonly usageBackends: readonly UsageBackendDescriptor[];
}
