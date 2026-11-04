import type { ArgsOf } from '../../shared/api/registry';
import { PromptCard } from './PromptCard';
import type { OwnerPromptEntry } from './PromptCard';
import { useLayoutEffect, useRef, useState } from 'react';

import type { ConnectionId } from '../../shared/adapter';
import { connectionInfo } from '../graph/agents';
import { Markdown } from './Markdown';
import { ToolDetailView } from './ToolDetail';
import type { BackgroundTask, Entry, Session, ToolProgress } from '../../shared/model/session';

/** What the transcript does with the user's answers to prompts (and its Stops). */
export interface TranscriptAnswers {
  onPromptReply?:
    ((need: string, answer: ArgsOf<'reply'>['answer']) => Promise<unknown>) | undefined;
  /** Switches the agent to another connection, as a notice offers (Terminal, for a login). */
  onSwitch?: (connection: ConnectionId) => void;
  /** Rewinds to before one of the user's messages: offered on each of `rewindPoints`. */
  onRewind?: (messageId: string) => void;
  /** The messages a rewind can go back to, as the agent view proves them (`rewindPointsOf`). */
  rewindPoints?: readonly string[];
  /** Stops a task a connected session runs in the background, from its tool call's line. */
  onStopTask?: (taskId: string) => void;
}

/**
 * A session's transcript: the user's messages, the agent's replies, thinking (folded), tool calls
 * (one line each, opening onto a diff or output, with how long it has run and how a subagent is
 * going; a subagent's work indented under it; a Stop on one running in the background), prompts
 * through the core's prompt owner), to-do lists, notices, /clear markers and turn times.
 * It keeps to the bottom while new entries arrive, unless scrolled up. `note` describes the
 * connection when its transcript is empty.
 */
export function Transcript({
  session,
  agentName,
  note,
  answers,
}: {
  session: Session;
  agentName: string;
  note: string;
  answers: TranscriptAnswers;
}) {
  const log = useRef<HTMLDivElement>(null);
  /** Whether the log was scrolled to its end, so new entries keep it there. */
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [session.entries, session.status]);
  /** The user's messages offered "Rewind to here": the agent view's points, no others. */
  const rewindable = new Set(answers.onRewind ? (answers.rewindPoints ?? []) : []);

  return (
    <div
      ref={log}
      className="agent-transcript"
      role="log"
      aria-label="Transcript"
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
        atEnd.current = scrollHeight - scrollTop - clientHeight < 40;
      }}
    >
      {session.entries.length === 0 && (
        <div className="agent-empty">
          <p>What should {agentName} do?</p>
          <p className="agent-empty-note">{note}</p>
        </div>
      )}
      {session.entries.map((entry) => {
        const view = (
          <EntryView
            key={entry.id}
            entry={entry}
            session={session}
            answers={answers}
            rewinds={rewindable.has(entry.id)}
          />
        );
        const parent = 'parent' in entry ? entry.parent : undefined;
        return parent === undefined ? (
          view
        ) : (
          <div key={entry.id} className="agent-subagent" data-parent={parent}>
            {view}
          </div>
        );
      })}
      {session.status !== 'idle' && (
        <p className="agent-working" role="status">
          <span className="agent-spinner" aria-hidden="true" />
          {session.status === 'waiting' ? 'Waiting for your answer' : 'Working…'}
          <span className="agent-working-hint">Esc to interrupt</span>
        </p>
      )}
    </div>
  );
}

function EntryView({
  entry,
  session,
  answers,
  rewinds,
}: {
  entry: Entry;
  session: Session;
  answers: TranscriptAnswers;
  /** Whether it offers "Rewind to here" (a message of the user's, in the conversation now). */
  rewinds: boolean;
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="agent-user">
          {entry.images !== undefined && entry.images.length > 0 && (
            <div className="agent-user-images">
              {entry.images.map((image, i) => (
                <img
                  key={i}
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={`Image ${String(i + 1)}`}
                />
              ))}
            </div>
          )}
          {entry.text !== '' && <p>{entry.text}</p>}
          {rewinds && (
            <button
              type="button"
              className="agent-rewind-here"
              title="Restore the code and conversation to before this message"
              onClick={() => {
                answers.onRewind?.(entry.id);
              }}
            >
              Rewind to here
            </button>
          )}
        </div>
      );
    case 'text':
      return (
        <div className="agent-text">
          <Markdown text={entry.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="agent-thinking">
          <summary>Thought for {entry.seconds}s</summary>
          {/* Markdown: the CLI's reasoning summaries open with a bold title. */}
          <Markdown text={entry.text} />
        </details>
      );
    case 'tool': {
      const task = session.tasks?.find((running) => running.tool === entry.id);
      const stop = answers.onStopTask;
      return (
        <ToolCall
          entry={entry}
          {...(task && stop
            ? {
                background: task,
                onStop: () => {
                  stop(task.id);
                },
              }
            : {})}
        />
      );
    }
    case 'todos':
      return (
        <div className="agent-todos" role="group" aria-label="To-dos">
          <ul>
            {entry.items.map((item) => (
              <li key={item.text} data-status={item.status}>
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'notice': {
      const { switchTo } = entry;
      const { onSwitch } = answers;
      return (
        <p
          className="agent-notice"
          data-level={entry.level}
          role={entry.level === 'error' ? 'alert' : 'note'}
        >
          {entry.text}
          {switchTo !== undefined && onSwitch && (
            <button
              type="button"
              className="agent-notice-switch"
              onClick={() => {
                onSwitch(switchTo);
              }}
            >
              Switch to {connectionInfo(switchTo).label}
            </button>
          )}
        </p>
      );
    }
    case 'cleared':
      return (
        <div className="agent-cleared" role="separator" aria-label="Conversation cleared">
          <span aria-hidden="true">Conversation cleared · The agent starts afresh from here</span>
        </div>
      );
    case 'end':
      return (
        <p className="agent-end" data-failed={entry.failed === true ? '' : undefined}>
          {entry.interrupted
            ? `Interrupted · ${String(entry.seconds)}s`
            : entry.failed === true
              ? `Failed after ${String(entry.seconds)}s`
              : `Worked for ${String(entry.seconds)}s`}
        </p>
      );
    case 'prompt':
      return (
        <PromptCard
          entry={entry as OwnerPromptEntry}
          onReply={(answer) =>
            answers.onPromptReply?.(entry.need, answer) ??
            Promise.reject(new Error('The prompt is no longer available.'))
          }
        />
      );
  }
}

/**
 * A tool call: one line (tool, what it acts on, how much it changed, how it is going, how it went)
 * that opens. One running in the background (`background`) has a Stop at its end.
 */
function ToolCall({
  entry,
  background,
  onStop,
}: {
  entry: Extract<Entry, { kind: 'tool' }>;
  background?: BackgroundTask;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { tool, summary, status, detail, progress } = entry;
  const counts =
    detail?.kind === 'diff' ? ` +${String(detail.added)} −${String(detail.removed)}` : '';
  /** How it is going, if there is anything to say. */
  const going = progress === undefined ? '' : progressText(progress, status);
  return (
    <div className="agent-tool" data-status={status} data-background={background ? '' : undefined}>
      <button
        type="button"
        aria-expanded={detail ? open : undefined}
        aria-label={`${tool} ${summary}${counts}`}
        aria-description={going === '' ? undefined : going}
        disabled={!detail}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="agent-tool-status" aria-hidden="true" />
        <span className="agent-tool-name">{tool}</span>
        <code className="agent-tool-summary">{summary}</code>
        {detail?.kind === 'diff' && (
          <span className="agent-diff" aria-hidden="true">
            <span className="agent-added">+{detail.added}</span>{' '}
            <span className="agent-removed">−{detail.removed}</span>
          </span>
        )}
        {going !== '' && (
          <span className="agent-tool-progress" aria-hidden="true">
            {going}
          </span>
        )}
      </button>
      {background && onStop && (
        <span className="agent-tool-actions">
          <button
            type="button"
            aria-label={`Stop ${background.description}`}
            title="It runs in the background: stop it"
            onClick={onStop}
          >
            Stop
          </button>
        </span>
      )}
      {open && detail && <ToolDetailView detail={detail} />}
    </div>
  );
}

/**
 * How a tool call is going, as the CLI says it: what a subagent does now, its tool uses and
 * tokens, and how long it has run ("Reading README.md · 1 tool use · 21.5k tokens · 4s"); once
 * done, "Done · …".
 */
function progressText({ seconds, doing, toolUses, tokens }: ToolProgress, status: string): string {
  const parts = [
    ...(status === 'running' && doing !== undefined ? [doing] : []),
    ...(status === 'done' && (toolUses !== undefined || tokens !== undefined) ? ['Done'] : []),
    ...(toolUses === undefined
      ? []
      : [`${String(toolUses)} tool ${toolUses === 1 ? 'use' : 'uses'}`]),
    ...(tokens === undefined ? [] : [`${tokenCount(tokens)} tokens`]),
    ...(seconds === undefined || (status !== 'running' && toolUses === undefined)
      ? []
      : [duration(seconds)]),
  ];
  return parts.join(' · ');
}

/** "950", "21.5k", "1.2m". */
function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const [scaled, unit] = tokens < 1_000_000 ? [tokens / 1000, 'k'] : [tokens / 1_000_000, 'm'];
  return `${scaled.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

/** "45s", "1m 15s". */
function duration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const rest = seconds % 60;
  return `${String(Math.floor(seconds / 60))}m${rest === 0 ? '' : ` ${String(rest)}s`}`;
}
