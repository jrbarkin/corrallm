import { useLayoutEffect, useRef, useState } from 'react';

import { Markdown } from './Markdown';
import type { Answer, Entry, Session } from './session';

/** The tools that run commands, and those that edit files, across the agents (agents.ts). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'exec_command', 'run_shell_command']);

/**
 * A session's transcript: the user's messages, the agent's replies, thinking (folded), tool calls
 * (one line each, opening onto a diff or output), permission prompts, to-do lists, and how long
 * each turn took. It keeps to the bottom while new entries arrive, unless scrolled up.
 */
export function Transcript({
  session,
  agentName,
  onAnswer,
}: {
  session: Session;
  agentName: string;
  onAnswer: (permissionId: string, answer: Answer) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  /** Whether the log was scrolled to its end, so new entries keep it there. */
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [session.entries, session.status]);

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
          <p className="agent-empty-note">
            Sessions are scripted for now: corrallm isn&apos;t connected to agents yet.
          </p>
        </div>
      )}
      {session.entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} onAnswer={onAnswer} />
      ))}
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
  onAnswer,
}: {
  entry: Entry;
  onAnswer: (permissionId: string, answer: Answer) => void;
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="agent-user">
          <p>{entry.text}</p>
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
          <p>{entry.text}</p>
        </details>
      );
    case 'tool':
      return <ToolCall entry={entry} />;
    case 'permission':
      return <Permission entry={entry} onAnswer={onAnswer} />;
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
    case 'end':
      return (
        <p className="agent-end">
          {entry.interrupted
            ? `Interrupted · ${String(entry.seconds)}s`
            : `Worked for ${String(entry.seconds)}s`}
        </p>
      );
  }
}

/** A tool call: one line (tool, what it acts on, how much it changed, how it went) that opens. */
function ToolCall({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const { tool, summary, status, detail } = entry;
  const counts =
    detail?.kind === 'diff' ? ` +${String(detail.added)} −${String(detail.removed)}` : '';
  return (
    <div className="agent-tool" data-status={status}>
      <button
        type="button"
        aria-expanded={detail ? open : undefined}
        aria-label={`${tool} ${summary}${counts}`}
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
      </button>
      {open && detail?.kind === 'diff' && (
        <pre className="agent-tool-detail agent-diff-lines">
          {detail.lines.map((line, i) => (
            <span key={i} data-line={line.kind}>
              {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {open && detail?.kind === 'output' && <pre className="agent-tool-detail">{detail.text}</pre>}
    </div>
  );
}

/** A permission prompt, as Claude Code words it; once answered, a line with the answer. */
function Permission({
  entry,
  onAnswer,
}: {
  entry: Extract<Entry, { kind: 'permission' }>;
  onAnswer: (permissionId: string, answer: Answer) => void;
}) {
  const shell = SHELL_TOOLS.has(entry.tool);
  const title = shell ? `${entry.tool === 'Bash' ? 'Bash' : 'Shell'} command` : 'Edit file';
  const choices: [Answer, string][] = [
    ['once', 'Yes'],
    [
      'always',
      shell ? `Yes, and don't ask again for ${entry.summary}` : 'Yes, allow all edits this session',
    ],
    ['deny', 'No'],
  ];
  const label = `${title}: ${entry.summary}`;
  if (entry.answer !== undefined) {
    const answered =
      entry.answer === 'deny' ? 'Denied' : entry.answer === 'always' ? 'Always allowed' : 'Allowed';
    return (
      <p
        className="agent-permission-answer"
        role="group"
        aria-label={label}
        data-answer={entry.answer}
      >
        {answered}: {entry.tool} <code>{entry.summary}</code>
      </p>
    );
  }
  return (
    <div className="agent-permission" role="group" aria-label={label}>
      <p className="agent-permission-title">{title}</p>
      <code className="agent-permission-summary">{entry.summary}</code>
      <p>
        {shell ? 'Do you want to proceed?' : `Do you want to make this edit to ${entry.summary}?`}
      </p>
      <div className="agent-permission-choices">
        {choices.map(([answer, text]) => (
          <button
            key={answer}
            type="button"
            onClick={() => {
              onAnswer(entry.id, answer);
            }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
