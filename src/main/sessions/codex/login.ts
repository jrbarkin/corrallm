import type { Consent, Distribution } from '../adapter';
import type { SessionEvent } from '../../../shared/session';
import { output } from '../transcript';

/*
 * How Codex is logged in, and what that allows. corrallm never reads, stores or passes
 * credentials: Codex uses its own login (~/.codex, from `codex login`), and corrallm only asks its
 * app server which kind it is (account/read).
 *
 * OpenAI on apps that run Codex's app server on a user's ChatGPT login (their plan's usage), in
 * the app server's docs (learn.chatgpt.com/docs/app-server, Auth endpoints): "If you’ve built a
 * local or open-source application using Codex app-server authentication, you can continue using
 * it, though we recommend migrating to Sign in with ChatGPT so users have greater control over and
 * visibility into their usage. App-server authentication has never been permitted for commercial
 * or hosted services." corrallm runs on the user's own computer, for them: so the App Server
 * connection runs on their ChatGPT plan once they allow it (planPrompt: for the session, or for
 * good, kept in main's settings), and refuses a ChatGPT login only in a build made as a commercial
 * or hosted product (`Distribution`). Sign in with ChatGPT (developers.openai.com/siwc) would have
 * corrallm keep and refresh the user's OAuth tokens itself, which it never does.
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

/** Why the App Server connection does not run on `login` in this build, or undefined if it does. */
export function appServerRefusal(
  login: CodexLogin,
  distribution: Distribution,
): string | undefined {
  switch (login.kind) {
    case 'apiKey':
    case 'other':
      return undefined;
    case 'none':
      return "Codex isn't logged in. Run `codex login` in a terminal (or switch this agent to Codex · Terminal and log in there), then try again.";
    case 'chatgpt':
      if (distribution === 'local') return undefined;
      return (
        'Codex is logged in with ChatGPT, and this corrallm is built as a commercial or hosted ' +
        'product, which OpenAI has never permitted to run Codex on a ChatGPT login. Switch this ' +
        'agent to Codex · Terminal to run Codex itself on your plan, or log Codex in with an ' +
        'OpenAI API key (`codex login --with-api-key`).'
      );
  }
}

/** Nothing kept: every session asks. */
export const ASK_EACH_SESSION: Consent = {
  given: () => Promise.resolve(false),
  give: () => Promise.resolve(),
};

/** What the App Server's docs say, as the prompt quotes it (hard-wrapped: it shows as is). */
const ALLOWANCE = [
  'OpenAI, on apps that run Codex on a ChatGPT login',
  '(learn.chatgpt.com/docs/app-server, Auth endpoints):',
  '',
  '  "If you’ve built a local or open-source application using Codex',
  '  app-server authentication, you can continue using it, though we',
  '  recommend migrating to Sign in with ChatGPT so users have greater',
  '  control over and visibility into their usage."',
  '',
  '  "App-server authentication has never been permitted for commercial',
  '  or hosted services."',
];

/**
 * The prompt that asks before a session first uses the user's ChatGPT plan (one with no 'always'
 * kept): Yes allows it for the session, "always" for good, No sends nothing.
 */
export function planPrompt(
  id: string,
  login: Extract<CodexLogin, { kind: 'chatgpt' }>,
): SessionEvent {
  const plan =
    login.plan === null ? 'ChatGPT' : login.plan.charAt(0).toUpperCase() + login.plan.slice(1);
  return {
    type: 'permission',
    id,
    tool: 'ChatGPT plan',
    summary: plan,
    title: 'Use your ChatGPT plan here?',
    detail: output(
      [
        `Codex is logged in with ChatGPT${login.plan === null ? '' : ` (${plan})`}: this agent's`,
        'turns would use your plan, through Codex’s app server.',
        '',
        ...ALLOWANCE,
        '',
        'corrallm runs on your computer, for you. Yes: for this session.',
        'Don’t ask again: for every Codex agent here. No: nothing is sent.',
      ].join('\n'),
    ),
    always: "Yes, and don't ask again on this computer",
  };
}

/** What the user is told when they do not let a session use their ChatGPT plan. */
export const PLAN_DECLINED =
  'Not sent: this agent uses your ChatGPT plan only once you allow it (send again to be asked ' +
  'again). Or switch it to Codex · Terminal, which is Codex itself on your plan, or log Codex in ' +
  'with an OpenAI API key (`codex login --with-api-key`).';
