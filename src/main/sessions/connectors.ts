import type { Connection } from '../../shared/session';
import type { Connector } from './connector';
import { unavailable } from './connector';
import { FakeConnector } from './fake';
import { SdkConnector } from './sdk/connector';

/**
 * The connector for each connection (see connector.ts), each from its own folder (sessions/sdk/,
 * sessions/terminal/). With `fake`, every connection runs the fake connector instead (e2e tests,
 * unpackaged builds only). `clientApp`: what the CLI is told runs it ("corrallm/0.1.0").
 */
export function createConnectors({
  fake,
  clientApp,
}: {
  fake: boolean;
  clientApp: string;
}): Record<Connection, Connector> {
  if (fake) {
    // A little time between events, so that a turn plays as a real one does.
    const connector = new FakeConnector({ pause: 40 });
    return { terminal: connector, sdk: connector };
  }
  return {
    terminal: unavailable('Claude Code in a terminal'),
    sdk: new SdkConnector({ clientApp }),
  };
}
