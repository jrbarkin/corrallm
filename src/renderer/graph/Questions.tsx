import { useState } from 'react';

import type { AskChoice, HeldAsk } from '../run/asks';
import type { Answer } from '../run/runner';
import { DEFAULT_AGENT } from './agents';
import type { AgentType } from './agents';
import type { Question } from './queue';

/** Who asks, labelled on a card: a button that opens that agent. */
interface Asker {
  name: string;
  type: AgentType;
  onOpen: () => void;
}

/**
 * Something the user is asked: by an agent (`agent`, when given), its text and what it comes after
 * (`detail`), a button for each of its choices (the primary one filled), and a box for an answer in
 * their words (`reply`: Enter, or its button). Once answered (`answered`), that instead. The one card for an
 * agent's own questions (QuestionCard) and for what the queues' run asks (run/asks.ts).
 */
export function AskCard({
  agent,
  text,
  detail,
  choices,
  reply,
  answered,
  onChoose,
  onReply,
}: {
  agent?: Asker | undefined;
  text: string;
  detail?: string | undefined;
  choices: readonly AskChoice[];
  /** The answer box, if any: its name and placeholder (`label`), and its button. */
  reply?: { label: string; button: string } | undefined;
  answered?: string | undefined;
  onChoose: (key: string) => void;
  onReply: (text: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const send = () => {
    if (answer.trim() !== '') onReply(answer.trim());
  };
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
      <p className="graph-question-text">{text}</p>
      {detail !== undefined && <p className="graph-question-detail">{detail}</p>}
      {answered === undefined ? (
        <>
          {choices.length > 0 && (
            <div className="graph-question-options">
              {choices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  data-primary={choice.primary ? '' : undefined}
                  {...(choice.title === undefined ? {} : { title: choice.title })}
                  onClick={() => {
                    onChoose(choice.key);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {reply && (
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
              <button type="button" disabled={answer.trim() === ''} onClick={send}>
                {reply.button}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="graph-question-answer">{answered}</p>
      )}
    </div>
  );
}

const ANSWER = { label: 'Your answer', button: 'Reply' };

/**
 * A question an agent asks the user: the agent's suggested answers as buttons, and a free answer
 * (Enter or Reply). Once answered, the answer. `agent`, when given, labels who is asking (a button
 * that opens that agent).
 */
export function QuestionCard({
  question,
  agent,
  onAnswer,
}: {
  question: Question;
  agent?: Asker;
  onAnswer: (answer: string) => void;
}) {
  return (
    <AskCard
      agent={agent}
      text={question.text}
      choices={(question.options ?? []).map((option) => ({ key: option, label: option }))}
      reply={ANSWER}
      answered={question.answer === undefined ? undefined : `You answered: ${question.answer}`}
      onChoose={onAnswer}
      onReply={onAnswer}
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
    question: Question;
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
