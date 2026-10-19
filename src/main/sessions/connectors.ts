import type { AdapterId, ConnectionId } from '../../shared/adapter';
import type { SessionMode } from '../../shared/session';
import type { ConnectorContext, Consent, OptionsReader } from './adapter';
import { ADAPTERS } from './adapters';
import type { Connector } from './connector';

/** The connector for each connection the catalog lists. */
export type Connectors = Readonly<Record<ConnectionId, Connector<SessionMode>>>;

/** Each adapter builds its connections, or supplies the fake used by unpackaged test builds. */
export function createConnectors({
  fake,
  consent,
  ...context
}: Omit<ConnectorContext, 'consent'> & {
  fake: boolean;
  consent: (adapter: AdapterId, key: string) => Consent;
}): Connectors {
  return Object.fromEntries(
    ADAPTERS.flatMap((adapter) => {
      if (fake) {
        const connector = adapter.fake?.(40);
        return connector === undefined
          ? []
          : adapter.descriptor.connections.map(({ id }) => [id, connector]);
      }
      return Object.entries(
        adapter.connectors?.({
          ...context,
          consent: (key) => consent(adapter.descriptor.id, key),
        }) ?? {},
      );
    }),
  );
}

/** The choices and user's defaults an adapter reads without starting a session. */
export function createOptions({ fake }: { fake: boolean }): Record<AdapterId, OptionsReader> {
  return Object.fromEntries(
    ADAPTERS.flatMap((adapter) => {
      const options = adapter.fakeOptions;
      const read = fake
        ? options === undefined
          ? undefined
          : () => Promise.resolve(options)
        : adapter.readOptions;
      return read === undefined ? [] : [[adapter.descriptor.id, read]];
    }),
  );
}
