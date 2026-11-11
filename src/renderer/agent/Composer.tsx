import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from 'react';
import { flushDrafts } from '../useDraft';
import { ipcErrorMessage } from '../ipc-error';

import type { AdapterId, ConnectionDescriptor } from '../../shared/adapter';
import { imageFactsRefusal, imageRefusal } from '../../shared/images';
import type { ImageFacts } from '../../shared/images';
import { imageBytes, IMAGE_TYPES } from '../../shared/session';
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
  /**
   * Why a message can't go as written, if the view knows before it is sent (its images the agent it
   * goes to, or the connection it would continue in, refuses). Then it is not sent, and the draft
   * and its images stay, with the reason shown. Where given it decides, over the composer's own rules.
   */
  refuses?: (text: string, images: MessageImage[]) => string | undefined;
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

/** What a composer's images are held to: its connection's own limits (src/shared/images.ts). */
export interface ImageRules {
  /** The connection's `images`; undefined for one the catalog doesn't know (it takes none). */
  declared: ConnectionDescriptor['images'] | undefined;
  /** Whose limits they are, as a sentence names them (an adapter and its connection). */
  subject: string;
}

/** An image pasted into the draft: what is sent, and how it shows. */
interface Attachment extends MessageImage {
  url: string;
}

/**
 * Why `added` can't join `kept` under `rules`, in words: the file's own refusal, named; or, where
 * the images kept already break the rules (the connection changed), theirs, not blamed on the file.
 */
function blame(
  kept: readonly ImageFacts[],
  added: ImageFacts,
  name: string,
  rules: ImageRules,
): string | undefined {
  const own = imageFactsRefusal(kept, rules.declared, rules.subject);
  if (own !== undefined) return `${own} Remove what doesn’t fit to add ${name}.`;
  const all = imageFactsRefusal([...kept, added], rules.declared, rules.subject);
  return all === undefined ? undefined : `${name}: ${all}`;
}

/** An attachment as the image limits see it. */
const factsOf = ({ mediaType, data }: Attachment): ImageFacts => ({
  mediaType,
  bytes: imageBytes(data),
});

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
 * Where the user writes to the agent: Enter sends, Shift+Enter starts a new
 * line, Shift+Tab switches mode (never into one that never asks), Up and Down bring back the
 * messages sent before (from the first or last line of the box; Down past the last brings the
 * draft back). While the agent works, Enter queues the message (shown above, ✕ takes it back to
 * edit) and Esc interrupts; otherwise Esc clears the draft. Under the box: the mode (its CLI's: its
 * menu offers modes that bypass permissions only once the user confirms them, unless the
 * session says its settings turn it off), the model (a connected session's own models, once it has
 * started), how hard it reasons (where its model offers a choice), what a connected session has
 * used, and Send (or Stop).
 *
 * A connected session's composer also completes slash commands ("/" at the start: Tab puts one
 * in, Enter runs it) and file mentions ("@": the project folder's files), takes images pasted
 * or dropped into it, sent with the message, offers what the CLI predicts the user sends next
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
  imageRules,
  initialDraft = '',
  initialImages = [],
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
  /**
   * What the images pasted, dropped or sent are held to: its connection's limits, within the
   * platform's ceilings. They are read again when a file has been read and when a message is sent.
   */
  imageRules: ImageRules;
  /** What its box starts with (a message rewound to, back to edit). */
  initialDraft?: string;
  /** The images its box starts with (a continuation the core refused, back to correct). */
  initialImages?: readonly MessageImage[];
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<Attachment[]>(() =>
    initialImages.map((image) => ({
      ...image,
      url: `data:${image.mediaType};base64,${image.data}`,
    })),
  );
  const [problem, setProblem] = useState<string>();
  /** The images held, shown or still being read: what a paste is counted against at once. */
  const held = useRef<{ shown: Attachment[]; reading: Map<object, ImageFacts & { name: string }> }>(
    {
      shown: images,
      reading: new Map(),
    },
  );
  /** The connection's limits as they are now, for a file whose read ends later. */
  const rules = useRef(imageRules);
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
    rules.current = imageRules;
  });
  useEffect(() => {
    const pending = held.current.reading;
    return () => {
      // Gone: no read that ends later is this draft's.
      pending.clear();
    };
  }, []);
  /** Shows these as the draft's images. */
  const show = (next: Attachment[]) => {
    held.current.shown = next;
    setImages(next);
  };
  /** Forgets the images and the reads begun: none comes back into a draft that was sent or cleared. */
  const clearImages = () => {
    held.current.reading.clear();
    show([]);
  };
  const working = session.status !== 'idle';
  const models = session.models ?? DEFAULT_MODEL;
  const model = models.find((m) => m.value === session.model) ?? models[0];
  const mode = session.mode === null ? undefined : modeOf(agent, session.mode);
  /** The modes it can switch to: its CLI's, unless the session said otherwise. */
  const modes = modesOf(agent).filter((m) => session.modes?.includes(m.mode) ?? true);
  /** Switches to a mode picked from the menu: one that never asks only once confirmed. */
  const pickMode = (picked: Mode) => {
    if (!cycledModes(agent).includes(picked) && session.mode !== picked) {
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
  /** What the empty box offers: the CLI's guess at what is sent next. */
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
    const [unread] = held.current.reading.values();
    if (unread !== undefined) {
      setProblem(`${unread.name} is still being read.`);
      return;
    }
    const attachments = images.map(({ mediaType, data }) => ({ mediaType, data }));
    // The connection it has now, not the one the images were pasted under.
    const reason = controls.refuses
      ? controls.refuses(text, attachments)
      : imageRefusal(attachments, imageRules.declared, imageRules.subject);
    if (reason !== undefined) {
      setProblem(reason);
      return;
    }
    void flushDrafts(() => {
      controls.send(text, attachments);
    }).catch((error: unknown) => {
      setProblem(ipcErrorMessage(error));
    });
    setDraft('');
    clearImages();
    setProblem(undefined);
    setRecalled(undefined);
  };

  /** Puts the completion in; a command picked with Enter runs at once. */
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

  /**
   * Adds pasted or dropped images to the draft, as many as the connection takes: each file is
   * counted against the images shown and those still being read before any is read, so rapid
   * pastes cannot overrun its count or the total. Every file it refuses is said so, in the words
   * of the limit that applies, and nothing else changes.
   */
  const attach = (files: readonly File[]) => {
    const refused: string[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.some((type) => type === file.type)) continue;
      const name = file.name || 'The image';
      const added: ImageFacts = { mediaType: file.type, bytes: file.size };
      const { shown, reading } = held.current;
      const why = blame([...shown.map(factsOf), ...reading.values()], added, name, imageRules);
      if (why !== undefined) {
        refused.push(why);
        continue;
      }
      const key = {};
      reading.set(key, { ...added, name });
      const reader = new FileReader();
      reader.onload = () => {
        // Gone, sent or cleared meanwhile: it is not this draft's any more.
        if (held.current.reading.get(key) === undefined) return;
        held.current.reading.delete(key);
        const url = typeof reader.result === 'string' ? reader.result : '';
        const data = url.slice(url.indexOf(',') + 1);
        if (data === '') {
          setProblem(`${name} couldn’t be read.`);
          return;
        }
        const image: Attachment = { mediaType: file.type as ImageType, data, url };
        // The connection it has now, with the images shown now and what it really holds.
        const again = blame(held.current.shown.map(factsOf), factsOf(image), name, rules.current);
        if (again !== undefined) {
          setProblem(again);
          return;
        }
        show([...held.current.shown, image]);
      };
      const failed = () => {
        // A read that fails gives its place back.
        if (!held.current.reading.delete(key)) return;
        setProblem(`${name} couldn’t be read.`);
      };
      reader.onerror = failed;
      reader.onabort = failed;
      reader.readAsDataURL(file);
    }
    if (refused.length > 0) {
      setProblem(
        refused.length <= 3
          ? refused.join(' ')
          : `${refused.slice(0, 3).join(' ')} (and ${String(refused.length - 3)} more)`,
      );
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
            <li key={queued.id} data-from={queued.from}>
              {queued.from === undefined ? queued.text : `From ${queued.from}: ${queued.text}`}
              {queued.images !== undefined && (
                <span className="agent-queued-images">
                  {' '}
                  [{queued.images.length === 1 ? 'Image' : `${String(queued.images.length)} images`}
                  ]
                </span>
              )}
              {/* A hand-off from a queue is the run's: Stop its run to take it back. */}
              {queued.from === undefined && (
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
              )}
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
                    show(images.filter((other) => other !== image));
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
            } else if (
              event.key === 'Escape' &&
              (working || draft !== '' || images.length > 0 || held.current.reading.size > 0)
            ) {
              // Otherwise Esc goes on to close the view.
              event.stopPropagation();
              if (working) controls.stop();
              else {
                setDraft('');
                clearImages();
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
