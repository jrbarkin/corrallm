import type { Catalog, ConnectionId } from '../../../shared/adapter';
import type { LeadGrants } from '../../../shared/api/ops/leads';
import type { CanvasId } from '../../../shared/canvas';
import type { NodeLike } from '../../../shared/model/canvas';
import { MADE_UP } from '../../../shared/test-made-up';
import type { PromptAnswers } from '../../sessions/connector';
import type { PromptOrigin } from '../../sessions/manager';
import type { PromptOwner } from './owner';

/*
 * B24 X1: the shared world of the lead tests (routing, copies, the allowance's agreement, managers)
 * over made-up connections, so none of them names a CLI.
 *
 * - `LEAD_CATALOG`: the made-up catalog with an API route on every connection, one that reports its
 *   human-only reasons (`SIGNALLING`, signals true) and one that does not (`QUIET`, signals false).
 *   `MADE_UP` itself, unchanged, has none with an API route: a lead on it can answer nothing.
 * - Teams of agents on those connections (`leadAgent`), and the grants a lead is given (`ALL_GRANTS`).
 * - Fake prompts a session raises (`approval`, `question`, `plan`), carrying no `signals` mark, so a
 *   lead may answer them (the shared fakes of the core's other tests are all human-only), and
 *   `raisePrompt` to raise one with a given owner.
 */

export const LEAD_CANVAS = '7f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f' as CanvasId;

/** The made-up catalog, every connection with an API route. */
export const LEAD_CATALOG: Catalog = {
  ...MADE_UP,
  adapters: MADE_UP.adapters.map((adapter) => ({
    ...adapter,
    connections: adapter.connections.map((connection) => ({ ...connection, api: 'channel' })),
  })),
};
/** A made-up connection that reports why a prompt is the user's alone (signals true). */
export const SIGNALLING = 'zed.acp' as ConnectionId;
/** A made-up connection that does not (signals false): a lead on its worker only rejects. */
export const QUIET = 'zed.free' as ConnectionId;

export const ALL_GRANTS: LeadGrants = { questions: true, plans: true, approvals: true };
export const QUESTIONS_ONLY: LeadGrants = { questions: true, plans: false, approvals: false };
export const APPROVALS_ONLY: LeadGrants = { questions: false, plans: false, approvals: true };

/** An agent node `id` on a made-up connection, nested in `parentId` if it has one. */
export function leadAgent(
  id: string,
  parentId?: string,
  connection: ConnectionId = SIGNALLING,
  label: string = id,
): NodeLike {
  return {
    id,
    type: 'agent',
    ...(parentId === undefined ? {} : { parentId }),
    data: { label, adapter: 'zed', connection } as NodeLike['data'],
  };
}

export const yes = { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} };
export const no = { value: 'no', label: 'No', hint: 'reject_once', effects: {} };
export const always = { value: 'always', label: 'Always', hint: 'allow_always', effects: {} };

/** A command approval offering `choices`, answerable through the API. */
export const approval = (choices: readonly object[] = [yes, no, always], more: object = {}) => ({
  kind: 'approval',
  title: 'Run it?',
  subject: { type: 'command', command: 'private-command-text', cwd: '/work' },
  answerIn: 'api',
  choices,
  ...more,
});
export const question = {
  kind: 'question',
  title: 'Which?',
  answerIn: 'api',
  questions: [
    {
      id: 'q1',
      header: 'H',
      text: 'Which?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiple: false,
      other: true,
    },
  ],
};
export const plan = {
  kind: 'plan',
  title: 'Plan',
  plan: 'Do it',
  answerIn: 'api',
  choices: [
    { value: 'go', label: 'Go', hint: 'allow_once', effects: {} },
    { value: 'stay', label: 'Stay', hint: 'reject_once', effects: {} },
  ],
};

/** The origin of a prompt raised by `agent`'s first generation on `connection`. */
export function promptOrigin(
  agent: string,
  answers: PromptAnswers,
  connection: ConnectionId = SIGNALLING,
  canvas: CanvasId = LEAD_CANVAS,
): PromptOrigin {
  return { canvas, agent, connection, generation: 1, live: true, startMode: 'plan', answers };
}

/** Answers that record what the session was given. */
export function recordingAnswers(given: unknown[] = []): PromptAnswers {
  return {
    answer: (_key, answer) => {
      given.push(answer);
    },
    decline: () => undefined,
    dismiss: () => undefined,
  };
}

/** Raises `prompt` from `agent` with `owner` under `key`, and returns the Need item that waits. */
export function raisePrompt(
  owner: PromptOwner,
  origin: PromptOrigin,
  key: string,
  prompt: object,
): string {
  owner.raised(origin, { type: 'prompt', key, prompt });
  const item = owner.items(origin.canvas).at(-1);
  if (item === undefined) throw new Error('not admitted');
  return item.id;
}
