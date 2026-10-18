import { useId, useState } from 'react';

import type { AdapterId } from '../../shared/adapter';
import type { TerminalAsk } from '../../shared/session';
import { Markdown } from '../agent/Markdown';
import type { NeedsItem } from '../../shared/model/needs';
import { promptQuestions } from '../../shared/model/session';
import type { CardQuestion } from '../../shared/model/session';
import { needsItem } from '../../shared/engine/needs';
import type { Need, NeedsInput } from '../../shared/engine/needs';
import { ToolDetailView } from '../agent/ToolDetail';
import { permissionQuestion } from '../agent/tools';
import type { AskChoice } from '../../shared/engine/run/asks';
import type { Answer } from '../../shared/engine/run/runner';
import { adapterCli, DEFAULT_AGENT } from './agents';

/** Who asks, labelled on a card: a button that opens that agent. */
interface Asker {
  name: string;
  type: AdapterId;
  onOpen: () => void;
}

/**
 * Something the user is asked: by an agent (`agent`, when given), under a short `header` (a chip),
 * its text and what it comes after (`detail`), a button for each of its choices (the primary one
 * filled; what a choice means, if it says, under it), and a box for an answer in their words
 * (`reply`: Enter, or its button). Once answered (`answered`), that instead. The one card for an
 * agent's own questions (QuestionCard) and for what the queues' run asks (src/shared/engine/run/asks.ts).
 *
 * With `onSubmit`, several choices may be picked: they toggle, and the reply's button (or Enter in
 * its box) submits them, with what was typed.
 */
export function AskCard({
  agent,
  header,
  text,
  detail,
  choices,
  reply,
  answered,
  onChoose,
  onReply,
  onSubmit,
}: {
  agent?: Asker | undefined;
  header?: string | undefined;
  text: string;
  detail?: string | undefined;
  choices: readonly AskChoice[];
  /** The answer box, if any: its name and placeholder (`label`), and its button. */
  reply?: { label: string; button: string } | undefined;
  answered?: string | undefined;
  onChoose: (key: string) => void;
  onReply: (text: string) => void;
  /** Takes the choices picked, by key, and what was typed (trimmed): several may be picked. */
  onSubmit?: ((keys: readonly string[], typed: string) => void) | undefined;
}) {
  const [answer, setAnswer] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const ids = useId();
  const typed = answer.trim();
  const ready = onSubmit ? picked.length > 0 || typed !== '' : typed !== '';
  const send = () => {
    if (!ready) return;
    if (onSubmit) onSubmit(picked, typed);
    else onReply(typed);
  };
  const described = choices.some((choice) => choice.detail !== undefined && choice.detail !== '');
  return (
    <div className="graph-question">
      {agent && (
        <button
          type="button"
          className="graph-question-agent"
          data-agent={agent.type}
          aria-label={`Open ${agent.name}`}
          onClick={agent.onOpen}
        >
          {agent.name}
        </button>
      )}
      {header !== undefined && header !== '' && (
        <span className="graph-question-header">{header}</span>
      )}
      <p className="graph-question-text">{text}</p>
      {detail !== undefined && <p className="graph-question-detail">{detail}</p>}
      {answered === undefined ? (
        <>
          {choices.length > 0 && (
            <div
              className="graph-question-options"
              data-described={described ? '' : undefined}
              role={onSubmit ? 'group' : undefined}
              aria-label={onSubmit ? 'Pick any' : undefined}
            >
              {choices.map((choice, i) => {
                const about = `${ids}-${String(i)}`;
                const meaning = choice.detail === '' ? undefined : choice.detail;
                return (
                  <button
                    key={choice.key}
                    type="button"
                    data-primary={choice.primary ? '' : undefined}
                    aria-pressed={onSubmit ? picked.includes(choice.key) : undefined}
                    {...(meaning === undefined
                      ? {}
                      : { 'aria-label': choice.label, 'aria-describedby': about })}
                    {...(choice.title === undefined ? {} : { title: choice.title })}
                    onClick={() => {
                      if (!onSubmit) onChoose(choice.key);
                      else {
                        setPicked(
                          picked.includes(choice.key)
                            ? picked.filter((key) => key !== choice.key)
                            : [...picked, choice.key],
                        );
                      }
                    }}
                  >
                    <span className="graph-question-option-label">{choice.label}</span>
                    {meaning !== undefined && (
                      <span id={about} className="graph-question-option-detail">
                        {meaning}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {reply ? (
            <div className="graph-question-reply">
              <input
                aria-label={reply.label}
                placeholder={reply.label}
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') send();
                }}
              />
              <button type="button" disabled={!ready} onClick={send}>
                {reply.button}
              </button>
            </div>
          ) : (
            onSubmit && (
              <div className="graph-question-reply">
                <button type="button" disabled={!ready} onClick={send}>
                  Submit
                </button>
              </div>
            )
          )}
        </>
      ) : (
        <p className="graph-question-answer">{answered}</p>
      )}
    </div>
  );
}

const ANSWER = { label: 'Your answer', button: 'Reply' };
const ANSWERS = { label: 'Your answer', button: 'Submit' };

/**
 * A question an agent asks the user: the agent's suggested answers as buttons (what each means
 * under it, when it says), and a free answer (Enter or Reply). A question that takes several
 * answers has them toggle, and Submit sends them, with what was typed, joined with ", " (as Claude
 * Code gives them). Once answered, the answer. `agent`, when given, labels who is asking (a button
 * that opens that agent).
 */
export function QuestionCard({
  question,
  agent,
  onAnswer,
}: {
  question: CardQuestion;
  agent?: Asker;
  onAnswer: (answer: string) => void;
}) {
  const choices = (question.options ?? []).map((option): AskChoice => {
    const { label, description } = typeof option === 'string' ? { label: option } : option;
    return {
      key: label,
      label,
      ...(description === undefined || description === '' ? {} : { detail: description }),
    };
  });
  return (
    <AskCard
      agent={agent}
      header={question.header}
      text={question.text}
      choices={choices}
      reply={question.multiple === true ? ANSWERS : ANSWER}
      answered={question.answer === undefined ? undefined : `You answered: ${question.answer}`}
      onChoose={onAnswer}
      onReply={onAnswer}
      onSubmit={
        question.multiple === true
          ? (keys, typed) => {
              onAnswer([...keys, ...(typed === '' ? [] : [typed])].join(', '));
            }
          : undefined
      }
    />
  );
}

/**
 * What a Terminal agent's Claude Code asks the user in its terminal, shown (never answered) here,
 * as Claude Code shows it: a permission (the tool, what it acts on, and the start of what its
 * prompt shows: a command in full, an edit's diff, a new file), its questions (each with its
 * header, and its answers with what they mean), a plan to approve, whether to trust the folder
 * (as it first runs there), or what it waits for, in its own words. The user answers in the
 * terminal: Open terminal opens the agent's view.
 */
export function TerminalAskCard({ ask, agent }: { ask: TerminalAsk; agent: Asker }) {
  const body = () => {
    switch (ask.kind) {
      case 'permission':
        return (
          <>
            <span className="graph-question-header">{ask.tool}</span>
            {ask.summary !== '' && <code className="graph-question-code">{ask.summary}</code>}
            {ask.detail && <ToolDetailView detail={ask.detail} />}
            <p className="graph-question-text">{permissionQuestion(ask.tool, ask.summary)}</p>
          </>
        );
      case 'question':
        return ask.questions.map((question, i) => (
          <div key={i} className="graph-question-asked">
            {question.header !== '' && (
              <span className="graph-question-header">{question.header}</span>
            )}
            <p className="graph-question-text">{question.text}</p>
            {question.options.length > 0 && (
              <ul className="graph-question-choices" aria-label="Its answers">
                {question.options.map((option) => (
                  <li key={option.label}>
                    <span className="graph-question-option-label">{option.label}</span>
                    {option.description !== '' && option.description !== option.label && (
                      <span className="graph-question-option-detail">{option.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ));
      case 'plan':
        return (
          <>
            <span className="graph-question-header">Plan</span>
            <p className="graph-question-text">Ready to code? Here is the plan:</p>
            {ask.plan.trim() !== '' && (
              <div className="graph-question-plan agent-text">
                <Markdown text={ask.plan} />
              </div>
            )}
          </>
        );
      case 'trust':
        return (
          <p className="graph-question-text">
            {adapterCli(agent.type)} asks whether you trust this folder before it works in it.
          </p>
        );
      case 'other':
        return <p className="graph-question-text">{ask.text}</p>;
    }
  };
  return (
    <div
      className="graph-question"
      data-in-terminal=""
      role="group"
      aria-label={`${agent.name} asks, in its terminal`}
    >
      <button
        type="button"
        className="graph-question-agent"
        data-agent={agent.type}
        aria-label={`Open ${agent.name}`}
        onClick={agent.onOpen}
      >
        {agent.name}
      </button>
      {body()}
      <div className="graph-question-terminal">
        <span>
          {ask.kind === 'trust'
            ? 'Trust this folder in the terminal.'
            : 'Answer it in the terminal.'}
        </span>
        <button type="button" onClick={agent.onOpen}>
          Open terminal
        </button>
      </div>
    </div>
  );
}

/**
 * What an agent's session asks that is answered in its view (a permission, a plan, an MCP server's
 * request): what it asks, and Open, which opens the agent's view to answer it there.
 */
export function SessionAskCard({ need, agent }: { need: NeedsItem; agent: Asker }) {
  return (
    <div className="graph-question" role="group" aria-label={`${agent.name} asks`}>
      <button
        type="button"
        className="graph-question-agent"
        data-agent={agent.type}
        aria-label={`Open ${agent.name}`}
        onClick={agent.onOpen}
      >
        {agent.name}
      </button>
      <p className="graph-question-text">{need.title}</p>
      {need.detail !== undefined && <p className="graph-question-detail">{need.detail}</p>}
      <div className="graph-question-terminal">
        <span>Answer it in its session.</span>
        <button type="button" onClick={agent.onOpen}>
          Open session
        </button>
      </div>
    </div>
  );
}

/**
 * A floating list of what needs the user, labelled by agent, as the engine derives it
 * (src/shared/engine/needs.ts): first what the queues' run holds for them (such as an OK), then
 * what agents' sessions ask (their questions, answered here; the rest in the agent's view), then
 * what Terminal agents' CLIs ask in their terminals (shown, answered there).
 */
export function QuestionsSidebar({
  needs,
  input,
  onDecide,
  onAnswer,
  onOpen,
}: {
  needs: readonly Need[];
  /** What the needs are worded with, for those shown in their words. */
  input: Omit<NeedsInput, 'stuck'>;
  onDecide: (agentId: string, itemId: string, answer: Answer) => void;
  /** Answers question `index` of the question prompt `promptId`. */
  onAnswer: (agentId: string, promptId: string, index: number, answer: string) => void;
  onOpen: (agentId: string) => void;
}) {
  const cards = needs.flatMap((need) => {
    const { agent } = need;
    const asker: Asker = {
      name: agent.data.label || 'Unnamed agent',
      type: agent.data.adapter ?? DEFAULT_AGENT,
      onOpen: () => {
        onOpen(agent.id);
      },
    };
    switch (need.kind) {
      case 'hold': {
        const { item, text, detail, choices, reply } = need.ask;
        return [
          <AskCard
            key={`${agent.id}/${item.id}`}
            agent={asker}
            text={text}
            detail={detail}
            choices={choices}
            reply={reply}
            onChoose={(choice) => {
              onDecide(agent.id, item.id, { choice });
            }}
            onReply={(typed) => {
              onDecide(agent.id, item.id, { reply: typed });
            }}
          />,
        ];
      }
      case 'prompt':
        if (need.prompt.kind === 'question') {
          return promptQuestions(need.prompt)
            .filter(({ question }) => question.answer === undefined)
            .map(({ prompt, index, question }) => (
              <QuestionCard
                key={`${agent.id}/${question.id}`}
                question={question}
                agent={asker}
                onAnswer={(answer) => {
                  onAnswer(agent.id, prompt, index, answer);
                }}
              />
            ));
        }
        return [
          <SessionAskCard
            key={`${agent.id}/${need.prompt.id}`}
            need={needsItem(need, input)}
            agent={asker}
          />,
        ];
      case 'ask':
        return [
          <TerminalAskCard key={`${agent.id}/${need.ask.id}`} ask={need.ask} agent={asker} />,
        ];
      case 'stuck':
        return [];
    }
  });
  return (
    <aside className="graph-questions" aria-label="Needs you">
      <h2>
        Needs you <span className="graph-questions-count">{cards.length}</span>
      </h2>
      {cards}
    </aside>
  );
}
