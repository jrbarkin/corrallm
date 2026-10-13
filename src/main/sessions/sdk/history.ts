import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SessionEvent } from '../../../shared/session';
import type { Places } from './tools';
import { property, text } from './tools';
import { Translator } from './translate';

/*
 * A resumed session's history, as the renderer shows it: the turns Claude Code kept in its
 * transcript (read back with the SDK's getSessionMessages), as the events they would have been
 * live, each turn ending with an 'end'. The transcript keeps what the model saw: since the last
 * compaction, without subagents' own work, and without the tools' structured results (an edit's
 * diff is rebuilt from what it was asked to change).
 */

/** What the CLI notes in the transcript when the user interrupts a turn. */
const INTERRUPTED = '[Request interrupted by user';
/** How the transcript keeps a slash command's output (what it printed, and its errors). */
const LOCAL_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/;

/** The events of a session's history, turn by turn. */
export function historyEvents(messages: readonly SessionMessage[], places: Places): SessionEvent[] {
  const translate = new Translator({ places, history: true });
  const events: SessionEvent[] = [];
  let turn:
    | { id: string; began: number | undefined; last: number | undefined; interrupted: boolean }
    | undefined;
  const end = () => {
    if (!turn) return;
    events.push(...translate.endTurn());
    const seconds =
      turn.began === undefined || turn.last === undefined ? 0 : (turn.last - turn.began) / 1000;
    events.push({
      type: 'end',
      messages: [turn.id],
      seconds: Math.max(1, Math.round(seconds)),
      interrupted: turn.interrupted,
      failed: false,
    });
    turn = undefined;
  };

  for (const message of messages) {
    const at = timestamp(message);
    /**
     * The turn did something: it lasts until then. Only its own work counts, not what the CLI
     * noted later (meta messages, system lines) nor the next message, which may come hours after.
     */
    const worked = () => {
      if (turn && at !== undefined) turn.last = at;
    };
    if (message.type === 'assistant') {
      worked();
      events.push(...translate.translate(asSdk({ ...message, type: 'assistant' })));
      continue;
    }
    if (message.type !== 'user' || message.parent_tool_use_id !== null) continue;
    if (flag(message, 'isCompactSummary')) {
      end();
      events.push({
        type: 'notice',
        id: message.uuid,
        level: 'info',
        text: 'The conversation was compacted: what came before is summarized for Claude.',
      });
      continue;
    }
    const content = property(message.message, 'content');
    const said = typed(content);
    // A slash command's output: kept as meta when only the user saw it (as /context's is).
    const local = said === undefined ? null : LOCAL_OUTPUT.exec(said);
    if (local) {
      worked();
      // /compact's "Compacted": the compaction's own notice says it.
      const output = local[2]?.trim() ?? '';
      if (output !== '' && !output.startsWith('Compacted')) {
        events.push({
          type: 'notice',
          id: message.uuid,
          level: local[1] === 'stderr' ? 'error' : 'info',
          text: output,
        });
      }
      continue;
    }
    if (flag(message, 'is_meta')) continue;
    if (said === undefined) {
      worked();
      events.push(
        ...translate.translate(asSdk({ ...message, type: 'user', tool_use_result: undefined })),
      );
      continue;
    }
    if (said.startsWith(INTERRUPTED)) {
      worked();
      if (turn) turn.interrupted = true;
      continue;
    }
    end();
    turn = { id: message.uuid, began: at, last: at, interrupted: false };
    events.push({ type: 'user', id: message.uuid, text: command(said) ?? said });
  }
  end();
  return events;
}

/** What the user typed, if the content is that (not tool results): its text. */
function typed(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => property(block, 'type') === 'tool_result')) return undefined;
  const parts = content.flatMap((block) => {
    const kind = property(block, 'type');
    if (kind === 'text') return [text(property(block, 'text')) ?? ''];
    if (kind === 'image') return ['[Image]'];
    return [];
  });
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** A slash command as the user typed it ("/compact keep the API notes"), from how it is kept. */
function command(said: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(said)?.[1];
  if (name === undefined) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(said)?.[1]?.trim() ?? '';
  const slash = name.startsWith('/') ? name : `/${name}`;
  return args === '' ? slash : `${slash} ${args}`;
}

function timestamp(message: SessionMessage): number | undefined {
  const at = text(property(message, 'timestamp'));
  const parsed = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function flag(message: SessionMessage, name: string): boolean {
  return property(message, name) === true;
}

/** A transcript message, as the live message it was (they share their shape where it matters). */
function asSdk(message: object): SDKMessage {
  return message as SDKMessage;
}
