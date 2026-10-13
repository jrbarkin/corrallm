import type { Connection } from '../../shared/session';
import type { Connector } from './connector';
import { unavailable } from './connector';
import { FakeConnector } from './fake';

/**
 * The connector for each connection (see connector.ts). The Agent SDK and terminal connectors
 * take the place of these placeholders, each from its own folder (sessions/sdk/, sessions/terminal/).
 * With `fake`, every connection runs the fake connector instead (e2e tests, unpackaged builds only).
 */
export function createConnectors({ fake }: { fake: boolean }): Record<Connection, Connector> {
  if (fake) {
    // A little time between events, so that a turn plays as a real one does.
    const connector = new FakeConnector({ pause: 40 });
    return { terminal: connector, sdk: connector };
  }
  return {
    terminal: unavailable('Claude Code in a terminal'),
    sdk: unavailable('Claude Code through the Agent SDK'),
  };
}
