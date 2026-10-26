import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from 'react';
import { flushDrafts } from '../useDraft';
import { ipcErrorMessage } from '../ipc-error';

import type { AdapterId } from '../../shared/adapter';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from '../../shared/api/limits';
import { imageBytes, IMAGE_TYPES, UNASKING_MODES } from '../../shared/session';
import type { ImageType, SlashCommand } from '../../shared/session';

import { ChoiceMenu } from './ChoiceMenu';
import { complete, completing, matchCommands } from './completion';
import type { Completing } from './completion';
import { cycledModes, modeOf, modesOf } from './modes';
import type {
  BackgroundTask,
  MessageImage,
  Mode,
  ModelChoice,
  Session,
  SessionUsage,
} from '../../shared/model/session';

/** What the composer does to its agent's session (src/main/core/engine/delivery/mailbox.ts). */
export interface ComposerControls {
  /** Sends a message, with the images pasted into it. */
  send: (text: string, images?: MessageImage[]) => void;
  stop: () => void;
  unqueue: (queuedId: string) => void;
  setMode: (mode: Mode) => void;
  setModel: (model: string) => void;
  /** Chooses how hard the model reasons (null: its default), where the session's models offer efforts. */
  setEffort?: (effort: string | null) => void;
  /** Stops a task a connected session runs in the background. */
  stopTask?: (taskId: string) => void;
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

/** What a connected session offers before it has said: its CLI's default model. */
const DEFAULT_MODEL: readonly ModelChoice[] = [{ value: 'default', label: 'Default model' }];

/** The effort menu's key for the model's default effort. */
const DEFAULT_EFFORT = 'default';

/**
 * Where the user writes to the agent, as in Claude Code: Enter sends, Shift+Enter starts a new
 * line, Shift+Tab switches mode (never into one that never asks), Up and Down bring back the
 * messages sent before (from the first or last line of the box; Down past the last brings the
 * draft back). While the agent works, Enter queues the message (shown above, ✕ takes it back to
 * edit) and Esc interrupts; otherwise Esc clears the draft. Under the box: the mode (its CLI's: its
 * menu offers bypassing permissions or Codex's Full access once the user confirms it, unless the
 * session says its settings turn it off), the model (a connected session's own models, once it has
 * started), how hard it reasons (where its model offers a choice, as Claude Code's /effort levels
 * and Codex's reasoning efforts), what a connected session has used, and Send (or Stop).
 *
 * A connected session's composer also completes slash commands ("/" at the start: Tab puts one
 * in, Enter runs it) and file mentions ("@": the project folder's files), takes images pasted
 * or dropped into it, sent with the message, offers what Claude Code predicts the user sends next
 * (the empty box shows it; Tab takes it), and lists the work the session runs in the background,
 * above the box, each with a Stop.
 */
export function Composer({
  agentName,
  agent,
  session,
  controls,
  field,
  placeholder,
  above,
  commands = session.commands,
  initialDraft = '',
}: {
  agentName: string;
  agent: AdapterId;
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
  /** What its box starts with (a message rewound to, back to edit). */
  initialDraft?: string;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string>();
  /** The mode that never asks it asks the user to confirm, picked from the mode menu. */
  const [confirming, setConfirming] = useState<Mode>();
  /** The completion picked in the menu, by its place. */
  const [active, setActive] = useState(0);
  /** The draft as it was when Esc closed the menu: it stays closed until the draft changes. */
  const [dismissed, setDismissed] = useState<string>();
  const [found, setFound] = useState<{ query: string; files: string[] }>();
  /** Which earlier message Up and Down have brought back, and the draft they took the place of. */
  const [recalled, setRecalled] = useState<{ index: number; draft: string }>();
  /** Where the caret goes once the draft a completion made is in the box. */
  const placeCaret = useRef<number | undefined>(undefined);
  const findFiles = useRef(controls.findFiles);
  const listId = useId();
  useEffect(() => {
    findFiles.current = controls.findFiles;
  });
  const working = session.status !== 'idle';
  const models = session.models ?? DEFAULT_MODEL;
  const model = models.find((m) => m.value === session.model) ?? models[0];
  const mode = session.mode === null ? undefined : modeOf(agent, session.mode);
  /** The modes it can switch to: its CLI's, unless the session said otherwise. */
  const modes = modesOf(agent).filter((m) => session.modes?.includes(m.mode) ?? true);
  /** Switches to a mode picked from the menu: one that never asks only once confirmed. */
  const pickMode = (picked: Mode) => {
    if (UNASKING_MODES.includes(picked) && session.mode !== picked) {
      setConfirming(picked);
      return;
    }
    setConfirming(undefined);
    controls.setMode(picked);
    field.current?.focus();
  };
  const confirmed = confirming === undefined ? undefined : modeOf(agent, confirming);
  const efforts = controls.setEffort ? (model?.efforts ?? []) : [];
  /** The effort it reasons at: the one chosen, else its model's default (where its CLI says it). */
  const effort = session.effort ?? model?.defaultEffort ?? null;
  const effortName = efforts.find((e) => e.value === effort)?.label ?? effort ?? 'Default';
  const tasks = session.tasks ?? [];
  /** What the empty box offers: Claude Code's guess at what is sent next. */
  const suggestion = working || placeholder !== undefined ? undefined : session.suggestion;
  /** The messages sent before, oldest first, each once in a row: what Up brings back. */
  const sent = useMemo(() => {
    const texts: string[] = [];
    for (const entry of session.entries) {
      if (entry.kind === 'user' && entry.text.trim() !== '' && texts.at(-1) !== entry.text) {
        texts.push(entry.text);
      }
    }
    return texts;
  }, [session.entries]);

  const at: Completing | undefined = completing(draft, caret);
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

  /** Brings back message `index` of those sent (past the last: the draft), caret at its end. */
  const recall = (index: number, kept: string) => {
    const text = index < sent.length ? (sent[index] ?? '') : kept;
    setRecalled(index < sent.length ? { index, draft: kept } : undefined);
    placeCaret.current = text.length;
    edit(text, text.length);
  };

  const submit = (text = draft) => {
    if (text.trim() === '' && images.length === 0) return;
    const attachments = images.map(({ mediaType, data }) => ({ mediaType, data }));
    void flushDrafts(() => {
      controls.send(text, attachments);
    }).catch((error: unknown) => {
      setProblem(ipcErrorMessage(error));
    });
    setDraft('');
    setImages([]);
    setProblem(undefined);
    setRecalled(undefined);
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
    let total = images.reduce((sum, { data }) => sum + imageBytes(data), 0);
    for (const file of files) {
      if (!IMAGE_TYPES.some((type) => type === file.type)) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        setProblem(`${file.name || 'The image'} is too large: images can be up to 5 MB.`);
        continue;
      }
      if (total + file.size > MAX_IMAGE_TOTAL) {
        setProblem(
          `${file.name || 'The image'} would take the images past 20 MB: a message’s images can ` +
            'be up to 20 MB together.',
        );
        continue;
      }
      total += file.size;
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
      {controls.stopTask && tasks.length > 0 && (
        <BackgroundTasks tasks={tasks} onStop={controls.stopTask} />
      )}
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
      {confirmed && (
        <div
          className="agent-bypass"
          role="alertdialog"
          aria-label={`${confirmed.label}?`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Esc says no, and leaves the view open.
            event.stopPropagation();
            setConfirming(undefined);
            field.current?.focus();
          }}
        >
          <p>
            <strong>{confirmed.label}?</strong> {agentName} won’t ask before it edits files or runs
            commands, so use it only where mistakes are easy to undo.
          </p>
          <button
            type="button"
            data-danger=""
            // It asks for the user's attention: the keyboard comes here.
            autoFocus
            onClick={() => {
              setConfirming(undefined);
              controls.setMode(confirmed.mode);
              field.current?.focus();
            }}
          >
            {confirmed.label}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(undefined);
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
          if (imagesIn(event.dataTransfer).length > 0) event.preventDefault();
        }}
        onDrop={(event: DragEvent) => {
          const dropped = imagesIn(event.dataTransfer);
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
          aria-autocomplete="list"
          aria-expanded={menu.length > 0}
          aria-controls={menu.length > 0 ? listId : undefined}
          aria-activedescendant={menu.length > 0 ? `${listId}-${String(picked)}` : undefined}
          placeholder={
            placeholder ??
            suggestion ??
            (working ? `Queue a message for ${agentName}…` : `Message ${agentName}…`)
          }
          value={draft}
          onChange={(event) => {
            setRecalled(undefined);
            edit(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            const pasted = imagesIn(event.clipboardData);
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
            const box = event.currentTarget;
            const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
            if (
              plain &&
              event.key === 'ArrowUp' &&
              !box.value.slice(0, box.selectionStart).includes('\n')
            ) {
              // From the first line, the message sent before the one shown (or the last sent).
              const index = recalled === undefined ? sent.length - 1 : recalled.index - 1;
              if (index < 0) return;
              event.preventDefault();
              recall(index, recalled?.draft ?? draft);
              return;
            }
            if (
              plain &&
              event.key === 'ArrowDown' &&
              recalled !== undefined &&
              !box.value.slice(box.selectionEnd).includes('\n')
            ) {
              event.preventDefault();
              recall(recalled.index + 1, recalled.draft);
              return;
            }
            if (plain && event.key === 'Tab' && suggestion !== undefined && draft === '') {
              // The suggestion offered goes into the box.
              event.preventDefault();
              placeCaret.current = suggestion.length;
              edit(suggestion, suggestion.length);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Tab' && event.shiftKey) {
              event.preventDefault();
              // Never into a mode that never asks; out of it, back to the first.
              const cycle = cycledModes(agent).filter((m) =>
                modes.some((offered) => offered.mode === m),
              );
              const index = session.mode === null ? -1 : cycle.indexOf(session.mode);
              const next = cycle[(index + 1) % cycle.length];
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
            value={mode?.label ?? 'Your default'}
            title={`${mode?.description ?? 'Uses your own settings'} (Shift+Tab to switch)`}
            choices={modes.map((m) => ({ key: m.mode, label: m.label, detail: m.description }))}
            chosen={mode?.mode ?? ''}
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
          {efforts.length > 0 && (
            <ChoiceMenu
              label="Effort"
              value={effortName}
              shown={`${effortName} effort`}
              title="How hard the model reasons, this session"
              choices={[
                // A model whose CLI does not say its default effort offers it as such.
                ...(model?.defaultEffort === undefined
                  ? [{ key: DEFAULT_EFFORT, label: 'Default', detail: 'The model’s own' }]
                  : []),
                ...efforts.map((e) => ({
                  key: e.value,
                  label: e.label,
                  ...(e.description === undefined ? {} : { detail: e.description }),
                })),
              ]}
              chosen={effort ?? DEFAULT_EFFORT}
              onChoose={(key) => {
                const picked = efforts.find((e) => e.value === key);
                controls.setEffort?.(picked?.value ?? null);
                field.current?.focus();
              }}
            />
          )}
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

/**
 * What a connected session has used: its cost so far, how full its context is, and how much of
 * each of the user's plan's usage limits is used (with when each resets, in its title).
 */
function Usage({ usage }: { usage: SessionUsage }) {
  const { costUsd, contextTokens, contextWindow, limits = [] } = usage;
  const context =
    contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 100)
      : null;
  const parts = [
    ...(costUsd === null ? [] : [`$${costUsd.toFixed(2)}`]),
    ...(context === null ? [] : [`${String(context)}% context`]),
    ...limits.map((limit) => `${limit.name} ${String(Math.round(limit.usedPercent))}%`),
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
        ...limits.map(
          (limit) =>
            `${String(Math.round(limit.usedPercent))}% of your ${limit.name} limit used` +
            (limit.resetsAt === null ? '' : `; it resets ${resetTime(limit.resetsAt)}`),
        ),
      ].join('. ')}
    >
      {parts.join(' · ')}
    </span>
  );
}

/**
 * The work a connected session runs in the background (subagents, commands), above the box, each
 * with a Stop.
 */
function BackgroundTasks({
  tasks,
  onStop,
}: {
  tasks: readonly BackgroundTask[];
  onStop: (taskId: string) => void;
}) {
  return (
    <ul className="agent-tasks" role="group" aria-label="Background tasks">
      {tasks.map((task) => (
        <li key={task.id} data-kind={task.kind}>
          <span className="agent-tasks-kind">
            {task.kind === 'agent' ? 'Subagent' : task.kind === 'command' ? 'Command' : 'Task'}
          </span>
          <span className="agent-tasks-description" title={task.description}>
            {task.description}
          </span>
          <button
            type="button"
            aria-label={`Stop ${task.description}`}
            title="Stop it"
            onClick={() => {
              onStop(task.id);
            }}
          >
            Stop
          </button>
        </li>
      ))}
    </ul>
  );
}

/** When a usage limit resets, as a date and time ("Oct 12, 3:04 PM"). */
function resetTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
