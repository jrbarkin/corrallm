import { useId, useState } from 'react';

import type { AdapterId } from '../../shared/adapter';

import type { AskChoice } from '../../shared/model/run-words';

/** Who asks, labelled on a card: a button that opens that agent. */
interface Asker {
  name: string;
  type: AdapterId | undefined;
  onOpen: () => void;
}

/**
 * Something the user is asked: by an agent (`agent`, when given), under a short `header` (a chip),
 * its text and what it comes after (`detail`), a button for each of its choices (the primary one
 * filled; what a choice means, if it says, under it), and a box for an answer in their words
 * (`reply`: Enter, or its button). Once answered (`answered`), that instead. The one card for an
 * questions for what the queues' run asks (src/shared/model/run-words.ts).
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
