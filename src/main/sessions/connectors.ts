import type { AdapterId, ConnectionId } from '../../shared/adapter';
import type { SessionMode } from '../../shared/session';
import type { ConnectorContext, Consent, Conversations, OptionsReader } from './adapter';
import { ADAPTERS } from './adapters';
import type { Connector } from './connector';
import { requireLocated } from './locate';

/** The connector for each connection the catalog lists. */
export type Connectors = Readonly<Record<ConnectionId, Connector<SessionMode>>>;

/** Each adapter builds its connections, or supplies the fake used by unpackaged test builds. */
export function createConnectors({
  fake,
  consent,
  ...context
}: Omit<ConnectorContext, 'consent' | 'executable'> & {
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
          executable: (env) => requireLocated(adapter, env),
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
      const actual = adapter.readOptions;
      const read = fake
        ? options === undefined
          ? undefined
          : () => Promise.resolve(options)
        : actual === undefined
          ? undefined
          : async (context: Parameters<OptionsReader>[0]) =>
              actual({ ...context, executable: await requireLocated(adapter, context.env) });
      return read === undefined ? [] : [[adapter.descriptor.id, read]];
    }),
  );
}

/** Each agent lists only the conversations its own adapter keeps. */
export function createConversations(): Partial<Record<AdapterId, Conversations>> {
  return Object.fromEntries(
    ADAPTERS.flatMap((adapter) => {
      const conversations = adapter.conversations?.({
        executable: (env) => requireLocated(adapter, env),
      });
      return conversations === undefined ? [] : [[adapter.descriptor.id, conversations]];
    }),
  );
}
