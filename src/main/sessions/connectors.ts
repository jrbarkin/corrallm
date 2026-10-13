import type {
  Cli,
  CodexMode,
  Connection,
  SessionMode,
  SettingsOptions,
} from '../../shared/session';
import type { UsageBackend, UsageWindows } from '../../shared/usage';
import { claudeOptions } from './claude-settings';
import { AppServerConnector } from './codex/app-server/connector';
import { requireCodex } from './codex/codex';
import type { Distribution, PlanConsent } from './codex/login';
import { codexOptions } from './codex/options';
import { CodexTerminalConnector } from './codex/terminal/connector';
import type { Connector } from './connector';
import { FAKE_CODEX_MODELS, FAKE_MODELS, FakeConnector } from './fake';
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
 * app server on their ChatGPT plan (codex/login.ts). `usage` takes the usage readings their CLIs
 * report (main's UsageReadings: usage.ts).
 */
export function createConnectors({
  fake,
  clientApp,
  distribution,
  consent,
  usage,
}: {
  fake: boolean;
  clientApp: string;
  distribution: Distribution;
  consent: PlanConsent;
  usage?: (backend: UsageBackend, windows: UsageWindows) => void;
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
  // Claude's readings come from its Terminal sessions' status lines, Codex's from its app server
  // (a Terminal session's own private one, for its readings only); the Agent SDK reads none.
  const readings = usage ? { usage } : {};
  return {
    terminal: new TerminalConnector(readings),
    sdk: new SdkConnector({ clientApp }),
    'codex-terminal': new CodexTerminalConnector(readings),
    'app-server': new AppServerConnector({ clientApp, distribution, consent, ...readings }),
  } satisfies Record<Connection, Connector<SessionMode>>;
}

/** Reads what an agent of a CLI can be set to run with, in a folder, for the agents' environment. */
export type OptionsReader = (context: {
  cwd: string;
  env: Readonly<Record<string, string>>;
}) => Promise<SettingsOptions>;

/**
 * What each CLI's agents can be set to run with, read without a session or a prompt: Claude Code's
 * from the user's settings (claude-settings.ts), Codex's from a private app server
 * (codex/options.ts). With `fake`, the fake connector's models, and no defaults of the user's.
 */
export function createOptions({ fake }: { fake: boolean }): Record<Cli, OptionsReader> {
  if (fake) {
    const none = { model: null, effort: null, mode: null };
    return {
      claude: () => Promise.resolve({ models: FAKE_MODELS, defaults: none }),
      codex: () => Promise.resolve({ models: FAKE_CODEX_MODELS, defaults: none }),
    };
  }
  return {
    claude: ({ cwd, env }) => claudeOptions(env, cwd),
    codex: async ({ cwd, env }) => codexOptions({ codex: await requireCodex(env), cwd, env }),
  };
}
