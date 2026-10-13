/*
 * How Codex is logged in, and what that allows. corrallm never reads, stores or passes
 * credentials: Codex uses its own login (~/.codex, from `codex login`), and corrallm only asks its
 * app server which kind it is (account/read).
 *
 * OpenAI allows a third-party app to run Codex's app server on a user's ChatGPT login (their plan's
 * usage) only for open-source and personal projects that run locally; paid or hosted apps need its
 * approval ("App-server authentication has never been permitted for commercial or hosted
 * services": learn.chatgpt.com/docs/app-server, Auth endpoints; and the usage terms of Sign in with
 * ChatGPT, developers.openai.com/siwc). So, as for Claude Code's Agent SDK, the App Server
 * connection runs on an API key (or another provider's login), and a ChatGPT plan is used through
 * the Terminal connection, which runs Codex's own CLI as the user would.
 */

/** Which kind of login Codex has. */
export type CodexLogin =
  | { kind: 'chatgpt'; plan: string | null }
  | { kind: 'apiKey' }
  /** Another provider's (Amazon Bedrock, or one that needs no OpenAI login at all). */
  | { kind: 'other'; type: string }
  | { kind: 'none' };

/** The login an account/read result says Codex has (`{ account, requiresOpenaiAuth }`). */
export function codexLogin(result: unknown): CodexLogin {
  const record = (value: unknown) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  const read = record(result);
  const account = record(read?.account);
  if (!account) {
    return read?.requiresOpenaiAuth === false
      ? { kind: 'other', type: 'provider' }
      : { kind: 'none' };
  }
  switch (account.type) {
    case 'chatgpt':
      return {
        kind: 'chatgpt',
        plan: typeof account.planType === 'string' ? account.planType : null,
      };
    case 'apiKey':
      return { kind: 'apiKey' };
    default:
      return { kind: 'other', type: typeof account.type === 'string' ? account.type : 'unknown' };
  }
}

/** Why the App Server connection does not run on `login`, or undefined if it does. */
export function appServerRefusal(login: CodexLogin): string | undefined {
  switch (login.kind) {
    case 'apiKey':
    case 'other':
      return undefined;
    case 'none':
      return "Codex isn't logged in. Run `codex login` in a terminal (or switch this agent to Codex · Terminal and log in there), then try again.";
    case 'chatgpt':
      return (
        'Codex is logged in with ChatGPT. OpenAI lets apps like corrallm use a ChatGPT plan through ' +
        'Codex only as Codex itself: switch this agent to Codex · Terminal to run it on your plan. ' +
        'To run it here, log Codex in with an OpenAI API key (`codex login --with-api-key`).'
      );
  }
}
