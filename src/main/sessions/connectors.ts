import type { CodexMode, Connection, SessionMode } from '../../shared/session';
import { AppServerConnector } from './codex/app-server/connector';
import type { Distribution, PlanConsent } from './codex/login';
import { CodexTerminalConnector } from './codex/terminal/connector';
import type { Connector } from './connector';
import { FakeConnector } from './fake';
import { SdkConnector } from './sdk/connector';
import { TerminalConnector } from './terminal/connector';

/** The connector of each connection, for the modes of the CLI it runs. */
export interface Connectors {
  readonly terminal: Connector;
  readonly sdk: Connector;
  readonly 'codex-terminal': Connector<CodexMode>;
  readonly 'app-server': Connector<CodexMode>;
}

/**
 * The connector for each connection (see connector.ts), each from its own folder: Claude Code's
 * (sessions/terminal/, sessions/sdk/) and Codex's (sessions/codex/terminal/,
 * sessions/codex/app-server/). With `fake`, every connection runs the fake connector instead (e2e
 * tests, unpackaged builds only). `clientApp`: what the CLI is told runs it ("corrallm/0.1.0").
 * `distribution` and `consent`: how this build is offered, and the user's say on running Codex's
 * app server on their ChatGPT plan (codex/login.ts).
 */
export function createConnectors({
  fake,
  clientApp,
  distribution,
  consent,
}: {
  fake: boolean;
  clientApp: string;
  distribution: Distribution;
  consent: PlanConsent;
}): Connectors {
  if (fake) {
    // A little time between events, so that a turn plays as a real one does.
    const claude = new FakeConnector({ pause: 40 });
    const codex = new FakeConnector({ pause: 40, cli: 'codex' });
    return {
      terminal: claude,
      sdk: claude,
      'codex-terminal': codex,
      'app-server': codex,
    } satisfies Record<Connection, Connector<SessionMode>>;
  }
  return {
    terminal: new TerminalConnector(),
    sdk: new SdkConnector({ clientApp }),
    'codex-terminal': new CodexTerminalConnector(),
    'app-server': new AppServerConnector({ clientApp, distribution, consent }),
  } satisfies Record<Connection, Connector<SessionMode>>;
}
