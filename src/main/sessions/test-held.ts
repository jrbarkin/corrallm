import type { SessionMode } from '../../shared/session';
import type { Connector, LiveSession, PromptAnswers, SessionHost } from './connector';
import { fakeConnector } from './test-fake';

/*
 * A made-up session for tests of B23 and what builds on it (B24): the connection whose sessions
 * hold their CLI's hook requests, as `yak.terminal` of `TWO_MADE_UP` does. It raises held prompts
 * answered in both places (`both`) or only through corrallm (`api`), and records what it is
 * answered, declined and released.
 */

export const HELD_KEY = '2c8e7a1b-4d5f-4a60-9b1c-3d4e5f6a7b8c';

export interface Held extends LiveSession<SessionMode> {
  host: SessionHost;
  answered: [string, unknown][];
  declined: [string, string][];
  released: string[];
  /** Raises a held approval, answered in `answerIn`, under `key`. */
  raise(answerIn: 'both' | 'api', key?: string): void;
}

/**
 * A connector of such sessions. `release`: whether they can let a hold go ('release'), do but
 * throw as they do ('throws'), or have none ('none': an Agent SDK or app-server session).
 */
export function heldConnector(release: 'release' | 'throws' | 'none' = 'release') {
  const fake = fakeConnector({ mode: 'plan' });
  const sessions: Held[] = [];
  const connector: Connector<SessionMode> = {
    start: async (spec, host) => {
      const session = (await fake.start(spec, host)) as Held;
      const prompts: PromptAnswers = {
        answer: (key, answer) => {
          session.answered.push([key, answer]);
        },
        decline: (key, why) => {
          session.declined.push([key, why]);
        },
        ...(release === 'none'
          ? {}
          : {
              release: (key: string) => {
                session.released.push(key);
                if (release === 'throws') throw new Error('cannot let go');
              },
            }),
      };
      Object.assign(session, {
        host,
        answered: [],
        declined: [],
        released: [],
        prompts,
        raise: (answerIn: 'both' | 'api', key = HELD_KEY) => {
          host.emit({
            type: 'prompt',
            key,
            prompt: {
              kind: 'approval',
              title: 'Yak wants to run a command',
              subject: { type: 'command', command: 'ls', cwd: '/work/app' },
              answerIn,
              until: Date.now() + 60_000,
              choices: [
                { value: 'yes', label: 'Yes', hint: 'allow_once', effects: {} },
                { value: 'no', label: 'No', hint: 'reject_once', effects: {} },
              ],
            } as never,
          });
        },
      });
      sessions.push(session);
      return session;
    },
  };
  return { connector, sessions };
}
