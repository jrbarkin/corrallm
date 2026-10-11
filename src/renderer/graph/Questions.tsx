import { useState } from 'react';

import type { AgentType } from './agents';
import type { Question } from './queue';

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
  agent?: { name: string; type: AgentType; onOpen: () => void };
  onAnswer: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const reply = () => {
    if (answer.trim() !== '') onAnswer(answer.trim());
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
      <p className="graph-question-text">{question.text}</p>
      {question.answer === undefined ? (
        <>
          {question.options && question.options.length > 0 && (
            <div className="graph-question-options">
              {question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    onAnswer(option);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <div className="graph-question-reply">
            <input
              aria-label="Your answer"
              placeholder="Your answer"
              value={answer}
              onChange={(event) => {
                setAnswer(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') reply();
              }}
            />
            <button type="button" disabled={answer.trim() === ''} onClick={reply}>
              Reply
            </button>
          </div>
        </>
      ) : (
        <p className="graph-question-answer">You answered: {question.answer}</p>
      )}
    </div>
  );
}

/** A floating list of the questions agents are waiting on, labelled by agent. */
export function QuestionsSidebar({
  pending,
  onAnswer,
  onOpen,
}: {
  pending: readonly {
    agentId: string;
    agentName: string;
    agentType: AgentType;
    question: Question;
  }[];
  onAnswer: (agentId: string, questionId: string, answer: string) => void;
  onOpen: (agentId: string) => void;
}) {
  return (
    <aside className="graph-questions" aria-label="Questions from agents">
      <h2>
        Questions <span className="graph-questions-count">{pending.length}</span>
      </h2>
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
