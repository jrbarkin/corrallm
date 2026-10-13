import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from 'react';

import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from '../../shared/session';
import type { ImageType, SlashCommand } from '../../shared/session';
import { AgentType } from '../graph/agents';
import { complete, completing, matchCommands } from './completion';
import type { Completing } from './completion';
import { CYCLED_MODES, MODES } from './session';
import type { MessageImage, Mode, ModelChoice, Session, SessionUsage } from './session';

/** What the composer does to its agent's session (sessions.ts). */
export interface ComposerControls {
  /** Sends a message, with the images pasted into it. */
  send: (text: string, images?: MessageImage[]) => void;
  stop: () => void;
  unqueue: (queuedId: string) => void;
  setMode: (mode: Mode) => void;
  setModel: (model: string) => void;
  /** The project folder's files matching what follows an "@", for a connected session. */
  findFiles?: (query: string) => Promise<string[]>;
}

/** An image pasted into the draft: what is sent, and how it shows. */
interface Attachment extends MessageImage {
  url: string;
}

/** A completion the composer offers: what it shows, and what goes into the draft. */
interface Choice {
  value: string;
  label: string;
  detail?: string;
}

/** The models each simulated agent offers (the Claude 5 family for Claude; others not listed). */
const MODELS: Record<AgentType, readonly string[]> = {
  [AgentType.Claude]: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1'],
  [AgentType.Codex]: ['Default model'],
  [AgentType.Qwen]: ['Default model'],
  [AgentType.Gemini]: ['Default model'],
};

/** What a connected session offers before it has said: its CLI's default model. */
const DEFAULT_MODEL: readonly ModelChoice[] = [{ value: 'default', label: 'Default model' }];

/**
 * Where the user writes to the agent, as in Claude Code: Enter sends, Shift+Enter starts a new
 * line, Shift+Tab switches mode (never into bypassing permissions). While the agent works, Enter
 * queues the message (shown above, ✕ takes it back to edit) and Esc interrupts; otherwise Esc
 * clears the draft. Under the box: the permission mode (its menu offers bypassing permissions,
 * once the user confirms it, unless the session says its settings turn it off), the model (a
 * connected session's own models, once it has started), what a connected session has used, and
 * Send (or Stop).
 *
 * A connected session's composer also completes slash commands ("/" at the start: Tab puts one
 * in, Enter runs it) and file mentions ("@": the project folder's files), and takes images pasted
 * or dropped into it, sent with the message.
 */
export function Composer({
  agentName,
  agent,
  connected,
  session,
  controls,
  field,
  placeholder,
  above,
  commands = session.commands,
}: {
  agentName: string;
  agent: AgentType;
  /** Whether it runs the real CLI (connected.ts) rather than a scripted session. */
  connected: boolean;
  session: Session;
  controls: ComposerControls;
  /** Its text box, which the view focuses again after the user answers a prompt. */
  field: RefObject<HTMLTextAreaElement | null>;
  /** What its empty box says, when what is sent there is not a message of its own. */
  placeholder?: string;
  /** What sits right above the text box (the queue's ⊕, and what the run asks of the user). */
  above?: ReactNode;
  /** The slash commands it completes: the session's, unless the view knows more. */
  commands?: readonly SlashCommand[] | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string>();
  /** Whether it asks the user to confirm bypassing permissions, picked from the mode menu. */
  const [confirming, setConfirming] = useState(false);
  /** The completion picked in the menu, by its place. */
  const [active, setActive] = useState(0);
  /** The draft as it was when Esc closed the menu: it stays closed until the draft changes. */
  const [dismissed, setDismissed] = useState<string>();
  const [found, setFound] = useState<{ query: string; files: string[] }>();
  /** Where the caret goes once the draft a completion made is in the box. */
  const placeCaret = useRef<number | undefined>(undefined);
  const findFiles = useRef(controls.findFiles);
  const listId = useId();
  useEffect(() => {
    findFiles.current = controls.findFiles;
  });
  const working = session.status !== 'idle';
  const models =
    session.models ??
    (connected
      ? DEFAULT_MODEL
      : MODELS[agent].map((name): ModelChoice => ({ value: name, label: name })));
  const model = models.find((m) => m.value === session.model) ?? models[0];
  const mode = MODES.find((m) => m.mode === session.mode) ?? MODES[0];
  /** The modes it can switch to: all, unless the session said otherwise. */
  const modes = MODES.filter((m) => session.modes?.includes(m.mode) ?? true);
  /** Switches to a mode picked from the menu: bypassing permissions only once confirmed. */
  const pickMode = (picked: Mode) => {
    if (picked === 'bypassPermissions' && session.mode !== picked) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    controls.setMode(picked);
    field.current?.focus();
  };

  const at: Completing | undefined = connected ? completing(draft, caret) : undefined;
  const mention = at?.kind === 'file' ? at.query : undefined;
  const choices: Choice[] =
    at?.kind === 'command'
      ? matchCommands(commands ?? [], at.query).map((command) => ({
          value: command.name,
          label: `/${command.name}`,
          detail: [command.argumentHint, command.description].filter(Boolean).join(' · '),
        }))
      : at?.kind === 'file' && found?.query === at.query
        ? found.files.map((file) => ({ value: file, label: file }))
        : [];
  const menu = choices.length > 0 && dismissed !== draft ? choices : [];
  const picked = Math.min(active, menu.length - 1);

  // The project's files for the mention being typed, a moment after typing stops.
  useEffect(() => {
    const find = findFiles.current;
    if (mention === undefined || !find) return;
    let current = true;
    const timer = setTimeout(() => {
      find(mention).then(
        (files) => {
          if (current) setFound({ query: mention, files });
        },
        () => undefined,
      );
    }, 80);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mention]);

  useLayoutEffect(() => {
    const place = placeCaret.current;
    if (place === undefined || !field.current) return;
    placeCaret.current = undefined;
    field.current.setSelectionRange(place, place);
    setCaret(place);
  }, [draft, field]);

  const edit = (text: string, at: number) => {
    setDraft(text);
    setCaret(at);
    setActive(0);
  };

  const submit = (text = draft.trim()) => {
    if (text === '' && images.length === 0) return;
    controls.send(
      text,
      images.map(({ mediaType, data }) => ({ mediaType, data })),
    );
    setDraft('');
    setImages([]);
    setProblem(undefined);
  };

  /** Puts the completion in; a command picked with Enter runs at once, as in Claude Code. */
  const accept = (choice: Choice, run: boolean) => {
    if (!at) return;
    const done = complete(draft, at, choice.value);
    if (run && at.kind === 'command') {
      submit(done.text.trim());
      return;
    }
    placeCaret.current = done.caret;
    edit(done.text, done.caret);
  };

  /** Adds pasted or dropped images to the draft (what Claude reads, up to its limits). */
  const attach = (files: readonly File[]) => {
    for (const file of files) {
      if (!IMAGE_TYPES.some((type) => type === file.type)) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setProblem(`${file.name || 'The image'} is too large: images can be up to 5 MB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        const data = url.slice(url.indexOf(',') + 1);
        if (data === '') return;
        setImages((before) =>
          before.length >= MAX_IMAGES
            ? before
            : [...before, { mediaType: file.type as ImageType, data, url }],
        );
      };
      reader.readAsDataURL(file);
    }
  };
  const imagesIn = (list: DataTransfer) =>
    [...list.files].filter((file) => IMAGE_TYPES.some((type) => type === file.type));

  return (
    <div className="agent-composer">
      {session.queued.length > 0 && (
        <ul className="agent-queued" aria-label="Queued messages">
          {session.queued.map((queued) => (
            <li key={queued.id}>
              {queued.text}
              {queued.images !== undefined && (
                <span className="agent-queued-images">
                  {' '}
                  [{queued.images.length === 1 ? 'Image' : `${String(queued.images.length)} images`}
                  ]
                </span>
              )}
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
      {confirming && (
        <div
          className="agent-bypass"
          role="alertdialog"
          aria-label="Bypass permissions?"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Esc says no, and leaves the view open.
            event.stopPropagation();
            setConfirming(false);
            field.current?.focus();
          }}
        >
          <p>
            <strong>Bypass permissions?</strong> {agentName} won’t ask before it edits files or runs
            commands, so use it only where mistakes are easy to undo.
          </p>
          <button
            type="button"
            data-danger=""
            // It asks for the user's attention: the keyboard comes here.
            autoFocus
            onClick={() => {
              setConfirming(false);
              controls.setMode('bypassPermissions');
              field.current?.focus();
            }}
          >
            Bypass permissions
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              field.current?.focus();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <div
        className="agent-input"
        onDragOver={(event: DragEvent) => {
          if (connected && imagesIn(event.dataTransfer).length > 0) event.preventDefault();
        }}
        onDrop={(event: DragEvent) => {
          const dropped = connected ? imagesIn(event.dataTransfer) : [];
          if (dropped.length === 0) return;
          event.preventDefault();
          attach(dropped);
        }}
      >
        {menu.length > 0 && (
          <div
            id={listId}
            className="agent-completions"
            role="listbox"
            aria-label={at?.kind === 'command' ? 'Commands' : 'Files'}
          >
            {menu.map((choice, i) => (
              <div
                key={choice.value}
                id={`${listId}-${String(i)}`}
                role="option"
                aria-selected={i === picked}
                tabIndex={-1}
                onMouseDown={(event) => {
                  // The text box keeps the keyboard.
                  event.preventDefault();
                }}
                onClick={() => {
                  accept(choice, false);
                }}
              >
                <span className="agent-completion-label">{choice.label}</span>
                {choice.detail !== undefined && choice.detail !== '' && (
                  <span className="agent-completion-detail">{choice.detail}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <ul className="agent-attachments" aria-label="Images">
            {images.map((image, i) => (
              <li key={image.url}>
                <img src={image.url} alt={`Image ${String(i + 1)}`} />
                <button
                  type="button"
                  aria-label={`Remove image ${String(i + 1)}`}
                  title="Remove"
                  onClick={() => {
                    setImages(images.filter((other) => other !== image));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {problem !== undefined && (
          <p className="agent-attachment-problem" role="alert">
            {problem}
          </p>
        )}
        <textarea
          ref={field}
          // The view opens to write to the agent.
          autoFocus
          rows={1}
          aria-label={`Message ${agentName}`}
          aria-autocomplete={connected ? 'list' : undefined}
          aria-expanded={connected ? menu.length > 0 : undefined}
          aria-controls={menu.length > 0 ? listId : undefined}
          aria-activedescendant={menu.length > 0 ? `${listId}-${String(picked)}` : undefined}
          placeholder={
            placeholder ?? (working ? `Queue a message for ${agentName}…` : `Message ${agentName}…`)
          }
          value={draft}
          onChange={(event) => {
            edit(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            const pasted = connected ? imagesIn(event.clipboardData) : [];
            if (pasted.length === 0) return;
            // An image is attached; text pasted with it still goes into the box.
            if (event.clipboardData.getData('text/plain') === '') event.preventDefault();
            attach(pasted);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const choice = menu[picked];
            if (choice && !event.shiftKey) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : menu.length - 1;
                setActive((picked + step) % menu.length);
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                accept(choice, event.key === 'Enter');
                return;
              }
              if (event.key === 'Escape') {
                // Esc closes the menu, not the view.
                event.stopPropagation();
                setDismissed(draft);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault();
              // Never into bypassing permissions; out of it, back to the first.
              const cycle = CYCLED_MODES.filter((m) => modes.some((offered) => offered.mode === m));
              const next = cycle[(cycle.indexOf(session.mode) + 1) % cycle.length];
              if (next !== undefined) controls.setMode(next);
            } else if (event.key === 'Escape' && (working || draft !== '' || images.length > 0)) {
              // Otherwise Esc goes on to close the view.
              event.stopPropagation();
              if (working) controls.stop();
              else {
                setDraft('');
                setImages([]);
              }
            }
          }}
        />
        <div className="agent-input-bar">
          <ChoiceMenu
            label="Mode"
            value={mode?.label ?? ''}
            title={`${mode?.description ?? ''} (Shift+Tab to switch)`}
            choices={modes.map((m) => ({ key: m.mode, label: m.label, detail: m.description }))}
            chosen={session.mode}
            onChoose={(key) => {
              const picked = modes.find((m) => m.mode === key);
              if (picked) pickMode(picked.mode);
            }}
          />
          <ChoiceMenu
            label="Model"
            value={model?.label ?? ''}
            title="The model it runs"
            choices={models.map((m) => ({
              key: m.value,
              label: m.label,
              ...(m.description === undefined ? {} : { detail: m.description }),
            }))}
            chosen={model?.value ?? ''}
            onChoose={(value) => {
              controls.setModel(value);
              field.current?.focus();
            }}
          />
          {session.usage && <Usage usage={session.usage} />}
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
              disabled={draft.trim() === '' && images.length === 0}
              onClick={() => {
                submit();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** What a connected session has used: its cost so far, and how full its context is. */
function Usage({ usage }: { usage: SessionUsage }) {
  const { costUsd, contextTokens, contextWindow } = usage;
  const context =
    contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 100)
      : null;
  const parts = [
    ...(costUsd === null ? [] : [`$${costUsd.toFixed(2)}`]),
    ...(context === null ? [] : [`${String(context)}% context`]),
  ];
  if (parts.length === 0) return null;
  return (
    <span
      className="agent-usage"
      title={[
        ...(costUsd === null ? [] : ['Its cost so far: an estimate on a subscription']),
        ...(context === null
          ? []
          : [`${String(contextTokens)} of ${String(contextWindow)} tokens of context used`]),
      ].join('. ')}
    >
      {parts.join(' · ')}
    </span>
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
