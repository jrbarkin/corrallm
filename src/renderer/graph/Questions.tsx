import { useId, useState } from 'react';

import type { AskChoice, HeldAsk } from '../run/asks';
import type { Answer } from '../run/runner';
import { DEFAULT_AGENT } from './agents';
import type { AgentType } from './agents';

/** Who asks, labelled on a card: a button that opens that agent. */
interface Asker {
  name: string;
  type: AgentType;
  onOpen: () => void;
}

/**
 * Something the user is asked: by an agent (`agent`, when given), under a short `header` (a chip),
 * its text and what it comes after (`detail`), a button for each of its choices (the primary one
 * filled; what a choice means, if it says, under it), and a box for an answer in their words
 * (`reply`: Enter, or its button). Once answered (`answered`), that instead. The one card for an
 * agent's own questions (QuestionCard) and for what the queues' run asks (run/asks.ts).
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

/**
 * What a question card asks. An agent's question on the canvas (Question) offers its answers by
 * name; one Claude Code asks in a session (AskUserQuestion) may also have a header (a chip), say
 * what each answer means, and take several answers (`multiple`).
 */
export interface CardQuestion {
  id: string;
  text: string;
  header?: string;
  options?: readonly (string | { label: string; description?: string })[];
  multiple?: boolean;
  answer?: string;
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
 * A floating list of what needs the user, labelled by agent: first what the queues' run holds for
 * them (`asks`, such as an OK), then the questions agents are waiting on.
 */
export function QuestionsSidebar({
  asks,
  pending,
  onDecide,
  onAnswer,
  onOpen,
}: {
  asks: readonly HeldAsk[];
  pending: readonly {
    agentId: string;
    agentName: string;
    agentType: AgentType;
    question: CardQuestion;
  }[];
  onDecide: (agentId: string, itemId: string, answer: Answer) => void;
  onAnswer: (agentId: string, questionId: string, answer: string) => void;
  onOpen: (agentId: string) => void;
}) {
  return (
    <aside className="graph-questions" aria-label="Needs you">
      <h2>
        Needs you <span className="graph-questions-count">{asks.length + pending.length}</span>
      </h2>
      {asks.map(({ agent, item, text, detail, choices, reply }) => (
        <AskCard
          key={`${agent.id}/${item.id}`}
          agent={{
            name: agent.data.label || 'Unnamed agent',
            type: agent.data.agent ?? DEFAULT_AGENT,
            onOpen: () => {
              onOpen(agent.id);
            },
          }}
          text={text}
          detail={detail}
          choices={choices}
          reply={reply}
          onChoose={(choice) => {
            onDecide(agent.id, item.id, { choice });
          }}
          onReply={(text) => {
            onDecide(agent.id, item.id, { reply: text });
          }}
        />
      ))}
      {pending.map(({ agentId, agentName, agentType, question }) => (
        <QuestionCard
          key={`${agentId}/${question.id}`}
          question={question}
          agent={{
            name: agentName,
            type: agentType,
            onOpen: () => {
              onOpen(agentId);
            },
          }}
          onAnswer={(answer) => {
            onAnswer(agentId, question.id, answer);
          }}
        />
      ))}
    </aside>
  );
}
