import { useLayoutEffect, useRef, useState } from 'react';

import type { Connection, ElicitationAction, FormValue, PlanMode } from '../../shared/session';
import { CONNECTION_INFO } from '../graph/agents';
import { QuestionCard } from '../graph/Questions';
import { Elicitation } from './Elicitation';
import { Markdown } from './Markdown';
import { MODES, sessionQuestions } from './session';
import type { Answer, Entry, PlanAnswer, Session } from './session';

/** The tools that run commands, and those that edit files, across the agents (agents.ts). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'exec_command', 'run_shell_command']);
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit',
  'replace',
  'write_file',
]);

/** What the transcript does with the user's answers to prompts. */
export interface TranscriptAnswers {
  onAnswer: (permissionId: string, answer: Answer) => void;
  onAnswerQuestion: (promptId: string, index: number, answer: string) => void;
  onAnswerPlan: (promptId: string, answer: PlanAnswer) => void;
  /** Switches the agent to another connection, as a notice offers (Terminal, for a login). */
  onSwitch?: (connection: Connection) => void;
  /** Rewinds to before one of the user's messages: offered on each, where it can be done. */
  onRewind?: (messageId: string) => void;
  /** Answers an MCP server's request: accepted (with the form's values), declined, cancelled. */
  onAnswerElicitation?: (
    promptId: string,
    action: ElicitationAction,
    values?: Record<string, FormValue>,
  ) => void;
}

/**
 * A session's transcript: the user's messages, the agent's replies, thinking (folded), tool calls
 * (one line each, opening onto a diff or output; a subagent's indented under it), prompts
 * (permission, the agent's questions, a plan to approve, an MCP server's form or link:
 * Elicitation.tsx), to-do lists, notices, and how long each
 * turn took. It keeps to the bottom while new entries arrive, unless scrolled up. `note`: what the
 * empty transcript says about how the session runs.
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
        const view = <EntryView key={entry.id} entry={entry} session={session} answers={answers} />;
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
}: {
  entry: Entry;
  session: Session;
  answers: TranscriptAnswers;
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
          {answers.onRewind && (
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
          <p>{entry.text}</p>
        </details>
      );
    case 'tool':
      return <ToolCall entry={entry} />;
    case 'permission':
      return <Permission entry={entry} onAnswer={answers.onAnswer} />;
    case 'question':
      return (
        <div className="agent-questions" role="group" aria-label="Questions for you">
          {sessionQuestions(session)
            .filter(({ prompt }) => prompt === entry.id)
            .map(({ index, question }) => (
              <QuestionCard
                key={question.id}
                question={question}
                onAnswer={(answer) => {
                  answers.onAnswerQuestion(entry.id, index, answer);
                }}
              />
            ))}
          {entry.withdrawn === true && (
            <p className="agent-permission-answer" data-answer="withdrawn">
              Not answered: {entry.questions.map((q) => q.text).join(' · ')}
            </p>
          )}
        </div>
      );
    case 'plan':
      return <Plan entry={entry} onAnswer={answers.onAnswerPlan} />;
    case 'elicitation':
      return (
        <Elicitation
          entry={entry}
          onAnswer={(action, values) => {
            answers.onAnswerElicitation?.(entry.id, action, values);
          }}
        />
      );
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
              Switch to {CONNECTION_INFO[switchTo].label}
            </button>
          )}
        </p>
      );
    }
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
      {open && detail && <Detail detail={detail} />}
    </div>
  );
}

/** A tool call's detail: an edit's diff, or a command's output. */
function Detail({ detail }: { detail: NonNullable<Extract<Entry, { kind: 'tool' }>['detail']> }) {
  if (detail.kind === 'output') return <pre className="agent-tool-detail">{detail.text}</pre>;
  return (
    <pre className="agent-tool-detail agent-diff-lines">
      {detail.lines.map((line, i) => (
        <span key={i} data-line={line.kind}>
          {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * A permission prompt, as Claude Code words it; once answered (or no longer asked), a line with
 * the answer. A connected session says what "always" allows, or that it offers no "always".
 */
function Permission({
  entry,
  onAnswer,
}: {
  entry: Extract<Entry, { kind: 'permission' }>;
  onAnswer: (permissionId: string, answer: Answer) => void;
}) {
  const shell = SHELL_TOOLS.has(entry.tool);
  const edit = EDIT_TOOLS.has(entry.tool);
  const title =
    entry.title ??
    (shell
      ? `${entry.tool === 'Bash' ? 'Bash' : 'Shell'} command`
      : edit
        ? 'Edit file'
        : `Use ${entry.tool}`);
  const always =
    entry.always === undefined
      ? shell
        ? `Yes, and don't ask again for ${entry.summary}`
        : 'Yes, allow all edits this session'
      : entry.always;
  const choices: [Answer, string][] = [
    ['once', 'Yes'],
    ...(always === null ? [] : [['always', always] as [Answer, string]]),
    ['deny', 'No'],
  ];
  const label = `${title}: ${entry.summary}`;
  if (entry.answer !== undefined || entry.withdrawn === true) {
    const answered =
      entry.answer === undefined
        ? 'Not answered'
        : entry.answer === 'deny'
          ? 'Denied'
          : entry.answer === 'always'
            ? 'Always allowed'
            : 'Allowed';
    return (
      <p
        className="agent-permission-answer"
        role="group"
        aria-label={label}
        data-answer={entry.answer ?? 'withdrawn'}
      >
        {answered}: {entry.tool} <code>{entry.summary}</code>
      </p>
    );
  }
  return (
    <div className="agent-permission" role="group" aria-label={label}>
      <p className="agent-permission-title">{title}</p>
      <code className="agent-permission-summary">{entry.summary}</code>
      {entry.detail && <Detail detail={entry.detail} />}
      <p>
        {edit ? `Do you want to make this edit to ${entry.summary}?` : 'Do you want to proceed?'}
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

/** How a plan can be carried out once approved, as Claude Code offers it. */
const PLAN_CHOICES: readonly [PlanMode, string][] = [
  ['auto', 'Yes, and use auto mode'],
  ['acceptEdits', 'Yes, and auto-accept edits'],
  ['manual', 'Yes, and manually approve edits'],
];

/** Plan mode's plan: approve it (and the mode to carry it out in), or say what to change. */
function Plan({
  entry,
  onAnswer,
}: {
  entry: Extract<Entry, { kind: 'plan' }>;
  onAnswer: (promptId: string, answer: PlanAnswer) => void;
}) {
  const [feedback, setFeedback] = useState('');
  const { answer } = entry;
  const open = answer === undefined && entry.withdrawn !== true;
  return (
    <div className="agent-plan" role="group" aria-label="Plan">
      <p className="agent-permission-title">Ready to code? Here is the plan:</p>
      <div className="agent-text agent-plan-text">
        <Markdown text={entry.plan} />
      </div>
      {open ? (
        <>
          <div className="agent-permission-choices">
            {PLAN_CHOICES.map(([mode, text]) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  onAnswer(entry.id, { approve: true, mode });
                }}
              >
                {text}
              </button>
            ))}
          </div>
          <div className="graph-question-reply">
            <input
              aria-label="What to change"
              placeholder="No, keep planning: tell Claude what to change"
              value={feedback}
              onChange={(event) => {
                setFeedback(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onAnswer(entry.id, { approve: false, feedback });
              }}
            />
            <button
              type="button"
              onClick={() => {
                onAnswer(entry.id, { approve: false, feedback });
              }}
            >
              Keep planning
            </button>
          </div>
        </>
      ) : (
        <p className="agent-permission-answer" data-answer={answer ? 'answered' : 'withdrawn'}>
          {answer === undefined
            ? 'Not answered'
            : answer.approve
              ? `Approved: carrying it out in ${MODES.find((m) => m.mode === answer.mode)?.label ?? answer.mode}`
              : `Kept planning${answer.feedback === '' ? '' : `: ${answer.feedback}`}`}
        </p>
      )}
    </div>
  );
}
