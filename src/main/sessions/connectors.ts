import type { Connection } from '../../shared/session';
import type { UsageBackend, UsageWindows } from '../../shared/usage';
import type { Connector } from './connector';
import { FakeConnector } from './fake';
import { SdkConnector } from './sdk/connector';
import { TerminalConnector } from './terminal/connector';

/**
 * The connector for each connection (see connector.ts), each from its own folder (sessions/sdk/,
 * sessions/terminal/). With `fake`, every connection runs the fake connector instead (e2e tests,
 * unpackaged builds only). `clientApp`: what the CLI is told runs it ("corrallm/0.1.0"). `usage`
 * takes the usage readings their CLIs report (main's UsageReadings: usage.ts).
 */
export function createConnectors({
  fake,
  clientApp,
  usage,
}: {
  fake: boolean;
  clientApp: string;
  usage?: (backend: UsageBackend, windows: UsageWindows) => void;
}): Record<Connection, Connector> {
  if (fake) {
    // A little time between events, so that a turn plays as a real one does.
    const connector = new FakeConnector({ pause: 40 });
    return { terminal: connector, sdk: connector };
  }
  return {
    terminal: new TerminalConnector(usage ? { usage } : {}),
    sdk: new SdkConnector({ clientApp }),
  };
}
