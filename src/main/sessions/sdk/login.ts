import { spawn } from '../process';

/*
 * How the `claude` the Agent SDK would run is logged in. Anthropic doesn't allow other products to
 * offer claude.ai logins or subscription rate limits through the Agent SDK without its approval,
 * so an SDK session starts only with an API key (ANTHROPIC_API_KEY, an apiKeyHelper, a bearer
 * token) or a cloud provider (Bedrock, Vertex, Foundry, a gateway); with a Claude subscription
 * login the agent runs in Terminal instead, which is Claude Code itself.
 *
 * corrallm asks the CLI, before the session starts: `claude auth status --json`, run with the
 * agents' environment in the project folder (so a project's apiKeyHelper counts). It reads what
 * kind of login that reports, never a credential. (The SDK's own account report comes only once
 * the CLI runs under the SDK, which is what a subscription login must not do.)
 */

/** What `claude auth status --json` reports, as far as corrallm reads it. */
export interface AuthStatus {
  loggedIn?: boolean;
  /** 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party' or 'none' (2.1.296). */
  authMethod?: string;
  /** 'firstParty' (Anthropic's API), or a cloud provider or gateway. */
  apiProvider?: string;
  /** The Claude plan, reported with a claude.ai login. */
  subscriptionType?: string | null;
}

/** Why the Agent SDK connection does not start with a subscription login, in one sentence. */
export const SUBSCRIPTION_LOGIN =
  "Claude Code is logged in with your Claude subscription, which Anthropic doesn't allow other " +
  'products to use through the Agent SDK: run this agent in Terminal, or give Claude Code an API ' +
  'key or a cloud provider.';

/** Why it does not start when the login could not be checked. */
export function uncheckedLogin(why: string): string {
  return (
    `corrallm couldn't check how Claude Code is logged in (${why}), and Anthropic doesn't allow ` +
    'other products to use a Claude subscription through the Agent SDK: run this agent in ' +
    'Terminal, or try again.'
  );
}

/** How long the CLI may take to say how it is logged in. */
const STATUS_MS = 15_000;
/** The most of its output read. */
const MAX_OUTPUT = 64 * 1024;

/**
 * Whether the CLI would run on a Claude subscription: a claude.ai login, or a token from
 * `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), reported as 'oauth_token'. An API key, an
 * apiKeyHelper or a cloud provider is not; nor is ANTHROPIC_AUTH_TOKEN in the agents'
 * environment (a bearer token for the API or a gateway, which the CLI sends before any login,
 * though it may still report the stored claude.ai login). Not being logged in at all is not
 * either: the session starts, and the CLI says so.
 */
export function onSubscription(status: AuthStatus, env: Readonly<Record<string, string>>): boolean {
  if (status.apiProvider !== undefined && status.apiProvider !== 'firstParty') return false;
  if ((env.ANTHROPIC_AUTH_TOKEN ?? '') !== '') return false;
  switch (status.authMethod) {
    case 'claude.ai':
    case 'oauth_token':
      return true;
    case 'api_key':
    case 'api_key_helper':
    case 'third_party':
      return false;
    default:
      return typeof status.subscriptionType === 'string';
  }
}

/**
 * Asks `claude` how it is logged in (`claude auth status --json`), in `cwd` with `env`. A
 * JavaScript CLI (a test's fake) runs with node, as the SDK runs it. Rejects if it fails, takes
 * too long, or does not answer in JSON.
 */
export function authStatus(
  claude: string,
  {
    cwd,
    env,
    timeoutMs = STATUS_MS,
  }: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs?: number },
): Promise<AuthStatus> {
  const script = /\.(?:[cm]?js|[jt]sx?)$/.test(claude);
  const [command, args] = script
    ? ['node', [claude, 'auth', 'status', '--json']]
    : [claude, ['auth', 'status', '--json']];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('it took too long to answer'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(0, MAX_OUTPUT);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-MAX_OUTPUT);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const said = errors.trim().split('\n').at(-1)?.trim() ?? '';
      let status: unknown;
      try {
        status = JSON.parse(output);
      } catch {
        reject(new Error(said === '' ? `claude auth status exited with ${String(code)}` : said));
        return;
      }
      if (typeof status !== 'object' || status === null || Array.isArray(status)) {
        reject(new Error('claude auth status said something else'));
        return;
      }
      const reported: AuthStatus = status;
      resolve(reported);
    });
  });
}
