import { useEffect, useId, useState } from 'react';

import { MAX_ANSWER_LENGTH } from '../../shared/api/limits';
import type { ArgsOf } from '../../shared/api/registry';
import type { NeedChoice } from '../../shared/model/needs';
import { formContent, formFields } from '../../shared/model/prompt-forms';
import type { LiveOutcome, PromptView } from '../../shared/model/prompt-views';
import type { PromptSubject, QuestionAnswer, QuestionAnswers } from '../../shared/model/prompts';
import type { EntryView } from '../../shared/model/views';
import type { ToolDetail } from '../../shared/session';
import { api } from '../api/client';
import { ipcErrorMessage } from '../ipc-error';
import { Form } from './Elicitation';
import './PromptCard.css';

export type OwnerPromptEntry = Extract<EntryView, { kind: 'prompt' }>;
type Reply = ArgsOf<'reply'>['answer'];
interface Props {
  entry: OwnerPromptEntry;
  onReply: (answer: Reply) => Promise<unknown>;
  onOpenTerminal?: (() => void) | undefined;
  openLink?: (url: string) => Promise<unknown>;
}

/** The core's prompt as the person may read it. Drafts belong to this occurrence and this view. */
export function PromptCard(props: Props) {
  if ('outcome' in props.entry)
    return (
      <section
        className="prompt-card prompt-ended"
        role="group"
        aria-label={props.entry.prompt.title}
      >
        <p className="prompt-source">Request from the agent or its MCP server</p>
        <p>{props.entry.prompt.title}</p>
        <p role="status">{outcomeWords(props.entry.outcome)}</p>
      </section>
    );
  return <Card key={props.entry.id} {...props} />;
}
function Card({
  entry,
  onReply,
  onOpenTerminal,
  openLink = (url) => api.linkOpen({ url }),
}: Props) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<NeedChoice>();
  const [feedback, setFeedback] = useState('');
  const prompt = entry.prompt;
  const act = async (call: () => Promise<unknown>, settles = true) => {
    if (busy || sent) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await call();
      if (settles) setSent(true);
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const live = prompt as PromptView;
  const body = [
    live.summary,
    live.reason,
    detailText(live.detail),
    live.kind === 'plan' ? live.plan : undefined,
    live.kind === 'approval' && live.subject ? subjectText(live.subject) : undefined,
  ].filter((part): part is string => part !== undefined && part !== '');
  const long = body.some((part) => part.length > 4000 || part.split('\n').length > 12);
  const reviewed = (!long || all) && entry.cut !== true;
  const questions = live.kind === 'question' ? live.questions : [];
  const choices = live.choices;
  const choose = (choice: NeedChoice) => {
    if (choice.feedback && choice.feedback !== 'none') setPicked(choice);
    else void act(() => onReply({ choice: choice.value }));
  };
  const text = (value: string) =>
    all || (value.length <= 4000 && value.split('\n').length <= 12)
      ? value
      : value.split('\n').slice(0, 12).join('\n').slice(0, 4000);
  const form = live.kind === 'form' ? live.form : undefined;
  return (
    <section className="prompt-card" role="group" aria-label={prompt.title}>
      <p className="prompt-source">
        {fromServer(live) ? 'MCP server’s request' : 'Agent’s request'}
      </p>
      <h4>{prompt.title}</h4>
      {body.map((part, index) => (
        <pre key={index}>{text(part)}</pre>
      ))}
      {live.humanOnly && <p>{live.humanOnly}</p>}
      {(live.cut ?? entry.cut) && <p>Some content was cut. The CLI has the whole request.</p>}
      {long && !all && <p>Showing a preview of the admitted request.</p>}
      {long && !all && (
        <button
          type="button"
          onClick={() => {
            setAll(true);
          }}
        >
          Show all
        </button>
      )}
      {problem && <p role="alert">{problem}</p>}
      {sent ? (
        <p role="status">Answer sent.</p>
      ) : (
        <fieldset disabled={busy} className="prompt-actions">
          {live.answerIn === 'terminal' && (
            <>
              {questions.map((question) => (
                <div key={question.id}>
                  {question.header && <p>{question.header}</p>}
                  <p>{question.text}</p>
                  {question.options.map((option) => (
                    <div key={option.label}>
                      <p>{option.label}</p>
                      {option.description && <p>{option.description}</p>}
                      {option.preview && <pre>{option.preview}</pre>}
                    </div>
                  ))}
                </div>
              ))}
              <p>Answer it in the terminal.</p>
              {onOpenTerminal && (
                <button type="button" onClick={onOpenTerminal}>
                  Open terminal
                </button>
              )}
            </>
          )}
          {live.answerIn === 'api' && live.until !== undefined && (
            <p>Its terminal waits on corrallm. Answer it here, or choose Answer in terminal.</p>
          )}
          {live.answerIn === 'both' && (
            <>
              <p>Or answer it in its terminal.</p>
              {onOpenTerminal && (
                <button type="button" onClick={onOpenTerminal}>
                  Open terminal
                </button>
              )}
            </>
          )}
          {live.until !== undefined && <Countdown until={live.until} />}
          {live.answerIn !== 'terminal' && live.kind === 'question' && (
            <QuestionFields
              questions={questions}
              onSend={(answers) => void act(() => onReply({ answers }))}
            />
          )}
          {live.answerIn !== 'terminal' &&
            form &&
            ('url' in form ? (
              <>
                <code>{form.url}</code>
                <button type="button" onClick={() => void act(() => openLink(form.url), false)}>
                  Open {hostOf(form.url)}
                </button>
                <button
                  type="button"
                  onClick={() => void act(() => onReply({ form: { action: 'accept' } }))}
                >
                  Tell {live.kind === 'form' ? (live.server ?? 'the server') : 'the server'} to go
                  on
                </button>
                <button
                  type="button"
                  onClick={() => void act(() => onReply({ form: { action: 'decline' } }))}
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => void act(() => onReply({ form: { action: 'cancel' } }))}
                >
                  Cancel
                </button>
              </>
            ) : (
              <Form
                explicit
                server={live.kind === 'form' ? (live.server ?? 'MCP server') : 'MCP server'}
                message=""
                fields={formFields(form.schema) ?? []}
                onAnswer={(action, values) => {
                  try {
                    const fields = formFields(form.schema);
                    if (!fields) throw new Error('This form cannot be displayed.');
                    const content =
                      action === 'accept' ? formContent(fields, values ?? {}) : undefined;
                    void act(() =>
                      onReply({
                        form: { action, ...(content === undefined ? {} : { values: content }) },
                      }),
                    );
                  } catch (error) {
                    setProblem(ipcErrorMessage(error));
                  }
                }}
              />
            ))}
          {choices
            .filter((choice) => live.answerIn !== 'terminal' || choice.value === 'not-waiting')
            .map((choice) => (
              <div key={choice.value}>
                <button
                  type="button"
                  disabled={choice.hint?.startsWith('allow_') === true && !reviewed}
                  onClick={() => {
                    choose(choice);
                  }}
                >
                  {choice.label}
                </button>
                {choice.description && <p>{choice.description}</p>}
                {choice.humanOnly && <p>{choice.humanOnly}</p>}
                {choice.effects && Object.keys(choice.effects).length > 0 && (
                  <pre>Effects: {JSON.stringify(choice.effects, null, 2)}</pre>
                )}
                {choice.endsTurn && <p>Ends this turn.</p>}
              </div>
            ))}
          {picked && (
            <>
              <label>
                Feedback
                <textarea
                  aria-label="Feedback"
                  value={feedback}
                  maxLength={MAX_ANSWER_LENGTH}
                  onChange={(event) => {
                    setFeedback(event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={picked.feedback === 'required' && feedback.trim() === ''}
                onClick={() =>
                  void act(() =>
                    onReply({
                      choice: picked.value,
                      ...(feedback.trim() === '' ? {} : { feedback }),
                    }),
                  )
                }
              >
                Send feedback
              </button>
            </>
          )}
        </fieldset>
      )}
    </section>
  );
}
/** A question's shape, whether a prompt's or an ask's. */
export interface FieldQuestion {
  id: string;
  header: string;
  text: string;
  options: readonly {
    label: string;
    description?: string | undefined;
    preview?: string | undefined;
  }[];
  multiple: boolean;
  other: boolean;
  secret?: boolean | undefined;
}

/**
 * The questions of a prompt or an ask to you, one card for both (B13): pick or type each answer,
 * then send them all at once. A draft belongs to this occurrence of the card.
 */
export function QuestionFields({
  questions,
  onSend,
}: {
  questions: readonly FieldQuestion[];
  onSend: (answers: QuestionAnswers) => void;
}) {
  const draftId = useId();
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const complete = questions.every((question) => {
    const answer = answerOf(answers, question.id);
    return (
      answer !== undefined &&
      ('text' in answer ? answer.text.trim() !== '' : answer.picked.length > 0)
    );
  });
  return (
    <>
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend>
            {question.header ? `${question.header}: ` : ''}
            {question.text}
          </legend>
          {question.options.map((option) => {
            const given = answerOf(answers, question.id);
            const chosen = given && 'picked' in given ? given.picked : [];
            return (
              <label key={option.label}>
                <input
                  type={question.multiple ? 'checkbox' : 'radio'}
                  name={`${draftId}/${question.id}`}
                  aria-label={option.label}
                  checked={chosen.includes(option.label)}
                  onChange={(event) => {
                    setAnswers((before) => ({
                      ...before,
                      [question.id]: {
                        picked: question.multiple
                          ? event.target.checked
                            ? [...chosen, option.label]
                            : chosen.filter((label) => label !== option.label)
                          : [option.label],
                      },
                    }));
                  }}
                />
                {option.label}
                {option.description && <span>{option.description}</span>}
                {option.preview && <pre>{option.preview}</pre>}
              </label>
            );
          })}
          {question.other && (
            <label>
              In your own words
              <input
                type={question.secret ? 'password' : 'text'}
                autoComplete="off"
                aria-label={question.text}
                maxLength={MAX_ANSWER_LENGTH}
                value={answerText(answerOf(answers, question.id))}
                onChange={(event) => {
                  setAnswers((before) => ({
                    ...before,
                    [question.id]: { text: event.target.value },
                  }));
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!complete}
        onClick={() => {
          onSend(answers);
        }}
      >
        Send answers
      </button>
    </>
  );
}
/** How long until a held prompt moves to its terminal (its `until`), counted down live. */
function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <p role="timer" className="prompt-countdown">
      {seconds === 0 ? 'Moving to its terminal…' : `Moves to its terminal in ${String(seconds)} s.`}
    </p>
  );
}
function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'link';
  }
}
function outcomeWords(outcome: LiveOutcome): string {
  switch (outcome.type) {
    case 'withdrawn':
      return 'No longer waiting.';
    case 'answered-in-terminal':
      return 'Answered in the terminal.';
    case 'moved':
      return 'Moved to its terminal.';
    case 'dismissed':
      return 'Not waiting.';
    case 'choice':
      return `${outcome.hint === 'allow_once' ? 'Allowed once' : outcome.hint === 'allow_always' ? 'Always allowed' : outcome.hint === 'reject_once' ? 'Declined' : outcome.hint === 'reject_always' ? 'Always declined' : 'Answered'} by ${outcome.by}.`;
    case 'answers':
      return `Answered${outcome.secret === true ? ' (secret)' : ''} by ${outcome.by}.`;
    case 'form':
      return `${outcome.action === 'accept' ? 'Submitted' : outcome.action === 'decline' ? 'Declined' : outcome.action === 'cancel' ? 'Cancelled' : 'Answered'} by ${outcome.by}.`;
  }
}
function subjectText(subject: PromptSubject | undefined): string {
  if (!subject) return '';
  switch (subject.type) {
    case 'command':
      return `Command:\n${subject.command}\nFolder: ${subject.cwd}`;
    case 'fileChange':
      return subject.files
        .map(({ path, diff }) => `File: ${path}${diff ? `\n${diff}` : ''}`)
        .join('\n');
    case 'mcpTool':
      return `MCP server: ${subject.server}\nTool: ${subject.tool}\n${JSON.stringify(subject.input, null, 2)}`;
    case 'tool':
      return `Tool: ${subject.tool}\n${JSON.stringify(subject.input, null, 2)}`;
    case 'trust':
      return 'Trust this project folder';
    case 'consent':
      return subject.text;
    default:
      return JSON.stringify(subject, null, 2);
  }
}

function detailText(detail: ToolDetail | undefined): string | undefined {
  if (!detail) return undefined;
  if (detail.kind === 'output') return detail.text;
  const marks = { add: '+', remove: '-', same: ' ' } as const;
  return detail.lines.map((line) => `${marks[line.kind]} ${line.text}`).join('\n');
}

function answerText(value: QuestionAnswer | undefined): string {
  return value && 'text' in value ? value.text : '';
}

function answerOf(answers: QuestionAnswers, id: string): QuestionAnswer | undefined {
  return Object.hasOwn(answers, id) ? answers[id] : undefined;
}

function fromServer(prompt: PromptView): boolean {
  if (prompt.kind === 'form') return true;
  return (
    prompt.kind === 'approval' &&
    (prompt.subject?.type === 'mcpTool' ||
      (prompt.subject?.type === 'tool' && prompt.subject.tool.startsWith('mcp__')))
  );
}
