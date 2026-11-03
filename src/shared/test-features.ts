import { connectionIn } from './adapter';
import type { AdapterDescriptor, Catalog, ConnectionDescriptor } from './adapter';
import type { SessionEvent } from './session';
import { TWO_MADE_UP } from './test-made-up';

/** Unfamiliar feature combinations, independent of the shipped adapters and native recordings. */
function featureCatalog(): Catalog {
  const result = structuredClone(TWO_MADE_UP);
  const [zed, yak] = result.adapters as [AdapterDescriptor, AdapterDescriptor];
  const [acp, free] = zed.connections as [ConnectionDescriptor, ConnectionDescriptor];
  Object.assign(zed, { role: 'append', resume: true, list: true });
  acp.panels = {
    resume: true,
    mcp: { changes: ['reconnect'] },
    rewind: { restores: ['conversation'] },
  };
  acp.live = { effort: true, stopTask: true };
  acp.images = { types: ['image/png'], maxBytes: 16, max: 1 };
  acp.continueIn = { connection: free.id, commands: [], shell: false, mcpSignIn: false };
  free.continueIn = {
    connection: 'zed.terminal',
    commands: [],
    shell: true,
    mcpSignIn: true,
  };
  const terminal: ConnectionDescriptor = {
    ...structuredClone(free),
    id: 'zed.terminal',
    label: 'Terminal',
    short: 'Terminal',
    view: 'terminal',
    // Synthetic input bytes: no native binding is claimed by this fixture.
    keys: { shiftEnter: '\x1b[13;2u' },
    shellPrefix: '$',
  };
  delete terminal.continueIn;
  zed.connections.push(terminal);
  const [, yakTerminal] = yak.connections as [ConnectionDescriptor, ConnectionDescriptor];
  yakTerminal.keys = { shiftEnter: null };
  const elmFree = { ...structuredClone(free), id: 'elm.free' };
  delete elmFree.continueIn;
  result.adapters.push({
    ...structuredClone(zed),
    id: 'elm',
    name: 'Elm Agent',
    accent: 2,
    role: 'append-new',
    list: false,
    connections: [elmFree],
  });
  return result;
}

export const FEATURE_CATALOG = featureCatalog();

export type FeatureReportFixture = Pick<AdapterDescriptor, 'role' | 'resume' | 'list'>;
/** Prepared data for the effective started contract; production validation belongs to its owner. */
export type FeatureStartedFixture = Extract<SessionEvent, { type: 'started' }> &
  FeatureReportFixture;
export interface FeatureGenerationFixture {
  generation: number;
  features: (FeatureReportFixture & Pick<ConnectionDescriptor, 'panels' | 'live'>) | null;
}

function fixture(connection: string) {
  const found = connectionIn(FEATURE_CATALOG, connection);
  if (!found) throw new Error(`No feature fixture for ${connection}`);
  return found;
}

export function featureStarted(connection: string): FeatureStartedFixture {
  const { adapter } = fixture(connection);
  return {
    type: 'started',
    model: null,
    mode: null,
    models: [],
    role: adapter.role,
    resume: adapter.resume,
    list: adapter.list,
  };
}

/** A supplied generation view, not the production readiness or method-intersection algorithm. */
export function featureGeneration(
  connection: string,
  generation: number,
  ready = true,
): FeatureGenerationFixture {
  const { adapter, connection: descriptor } = fixture(connection);
  return {
    generation,
    features: ready
      ? structuredClone({
          role: adapter.role,
          resume: adapter.resume,
          list: adapter.list,
          panels: descriptor.panels,
          live: descriptor.live,
        })
      : null,
  };
}
