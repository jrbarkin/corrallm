import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { AgentType } from '../graph/agents';
import { MODES } from './session';
import type { Mode, Session } from './session';

/** What the composer does to its agent's session (sessions.ts). */
export interface ComposerControls {
  send: (text: string) => void;
  stop: () => void;
  unqueue: (queuedId: string) => void;
  setMode: (mode: Mode) => void;
  setModel: (model: string) => void;
}

/** The models each agent offers (the Claude 5 family for Claude; others are not listed yet). */
const MODELS: Record<AgentType, readonly string[]> = {
  [AgentType.Claude]: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1'],
  [AgentType.Codex]: ['Default model'],
  [AgentType.Qwen]: ['Default model'],
  [AgentType.Gemini]: ['Default model'],
};

/**
 * Where the user writes to the agent, as in Claude Code: Enter sends, Shift+Enter starts a new
 * line, Shift+Tab switches mode. While the agent works, Enter queues the message (shown above, ✕
 * takes it back to edit) and Esc interrupts; otherwise Esc clears the draft. Under the box: the
 * permission mode, the model, and Send (or Stop).
 */
export function Composer({
  agentName,
  agent,
  session,
  controls,
  field,
  above,
}: {
  agentName: string;
  agent: AgentType;
  session: Session;
  controls: ComposerControls;
  /** Its text box, which the view focuses again after the user answers a prompt. */
  field: RefObject<HTMLTextAreaElement | null>;
  /** What sits right above the text box (the queue's ⊕). */
  above?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const working = session.status !== 'idle';
  const models = MODELS[agent];
  const model =
    session.model !== null && models.includes(session.model) ? session.model : models[0];
  const mode = MODES.find((m) => m.mode === session.mode) ?? MODES[0];

  const submit = () => {
    const text = draft.trim();
    if (text === '') return;
    controls.send(text);
    setDraft('');
  };

  return (
    <div className="agent-composer">
      {session.queued.length > 0 && (
        <ul className="agent-queued" aria-label="Queued messages">
          {session.queued.map((queued) => (
            <li key={queued.id}>
              {queued.text}
              <button
                type="button"
                aria-label={`Edit queued message: ${queued.text}`}
                title="Take it back to edit"
                onClick={() => {
                  controls.unqueue(queued.id);
                  setDraft(queued.text);
                  field.current?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {above}
      <div className="agent-input">
        <textarea
          ref={field}
          // The view opens to write to the agent.
          autoFocus
          rows={1}
          aria-label={`Message ${agentName}`}
          placeholder={working ? `Queue a message for ${agentName}…` : `Message ${agentName}…`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault();
              const at = MODES.findIndex((m) => m.mode === session.mode);
              const next = MODES[(at + 1) % MODES.length];
              if (next) controls.setMode(next.mode);
            } else if (event.key === 'Escape' && (working || draft !== '')) {
              // Otherwise Esc goes on to close the view.
              event.stopPropagation();
              if (working) controls.stop();
              else setDraft('');
            }
          }}
        />
        <div className="agent-input-bar">
          <ChoiceMenu
            label="Mode"
            value={mode?.label ?? ''}
            title={`${mode?.description ?? ''} (Shift+Tab to switch)`}
            choices={MODES.map((m) => ({ key: m.mode, label: m.label, detail: m.description }))}
            chosen={session.mode}
            onChoose={(key) => {
              const picked = MODES.find((m) => m.mode === key);
              if (picked) controls.setMode(picked.mode);
              field.current?.focus();
            }}
          />
          <ChoiceMenu
            label="Model"
            value={model ?? ''}
            title="The model it runs"
            choices={models.map((name) => ({ key: name, label: name }))}
            chosen={model ?? ''}
            onChoose={(name) => {
              controls.setModel(name);
              field.current?.focus();
            }}
          />
          {working ? (
            <button
              type="button"
              className="agent-stop"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={controls.stop}
            />
          ) : (
            <button
              type="button"
              className="agent-send"
              aria-label="Send"
              title="Send (Enter)"
              disabled={draft.trim() === ''}
              onClick={submit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** A button showing a choice ("Mode: Manual"), opening a menu of the others. */
function ChoiceMenu({
  label,
  value,
  title,
  choices,
  chosen,
  onChoose,
}: {
  label: string;
  value: string;
  title: string;
  choices: readonly { key: string; label: string; detail?: string }[];
  chosen: string;
  onChoose: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="agent-choice"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        // Esc closes the menu, not the view.
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={`${label}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {value}
      </button>
      {open && (
        <div className="agent-choice-menu" role="menu" aria-label={label}>
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="menuitemradio"
              aria-checked={choice.key === chosen}
              onClick={() => {
                setOpen(false);
                onChoose(choice.key);
              }}
            >
              <span>{choice.label}</span>
              {choice.detail !== undefined && (
                <span className="agent-choice-detail">{choice.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
