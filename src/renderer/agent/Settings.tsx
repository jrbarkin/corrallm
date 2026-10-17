import { useEffect, useRef, useState } from 'react';

import type {
  AgentSettings,
  Cli,
  Connection,
  ModelChoice,
  SessionMode,
  SettingsOptions,
} from '../../shared/session';
import type { AgentType } from '../graph/agents';
import { ipcErrorMessage } from '../ipc-error';
import { ChoiceMenu } from './ChoiceMenu';
import { cycledModes, modeOf, STARTING_MODES } from './session';

/** How each CLI is named, and where the user's own defaults come from. */
const CLI_WORDS: Readonly<Record<Cli, { name: string; yours: string; its: string }>> = {
  claude: {
    name: 'Claude Code',
    yours: 'Yours, from Claude Code’s settings',
    its: 'Claude Code’s choice for your account',
  },
  codex: { name: 'Codex', yours: 'Yours, from your Codex config', its: 'Codex’s choice' },
};

/** The menus' key for nothing chosen: the user's own default. */
const DEFAULT = '';

/**
 * What a Terminal agent's CLI starts with: its model, reasoning effort (where the model has one)
 * and mode, beside its agent chip. The button says them ("Opus · Extra high · Auto"), with the
 * user's own defaults where nothing is chosen (read without a prompt, and never changed: main's
 * session:options); the panel it opens chooses them, from the models the CLI takes. They are the
 * agent's settings, saved with it in the canvas's file, and passed on its CLI's command line as
 * its session starts: a session that runs keeps what it started with, until restarted here
 * (resuming its conversation).
 */
export function SettingsMenu({
  cli,
  connection,
  agent,
  settings,
  options,
  running,
  working,
  onChange,
  onRestart,
  inline = false,
  onOpen,
  label,
  prefix,
  suffix,
}: {
  cli: Cli;
  connection: Connection;
  agent: AgentType;
  settings: AgentSettings;
  /** What the CLI's agents can be set to, and the user's own defaults (asked of main once). */
  options: (cli: Cli) => Promise<SettingsOptions>;
  /** What the session that runs started with, if one runs. */
  running: AgentSettings | undefined;
  /** Whether the agent is in a turn (a restart would end it). */
  working: boolean;
  onChange?: (settings: AgentSettings) => void;
  onRestart?: () => void;
  /** The shared agent settings sheet embeds the choices, without another popover. */
  inline?: boolean;
  onOpen?: () => void;
  label?: string;
  prefix?: string;
  suffix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<{ options?: SettingsOptions; problem?: string }>({});
  // Read once for its CLI (main's answer is kept by the store), whatever the view renders meanwhile.
  const ask = useRef(options);
  useEffect(() => {
    ask.current = options;
  });
  useEffect(() => {
    let current = true;
    ask.current(cli).then(
      (given) => {
        if (current) setRead({ options: given });
      },
      (error: unknown) => {
        if (current) setRead({ problem: ipcErrorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [cli]);

  const words = CLI_WORDS[cli];
  const models: readonly ModelChoice[] = read.options?.models ?? [];
  const defaults = read.options?.defaults ?? { model: null, effort: null, mode: null };
  const named = (value: string | null) => models.find((m) => m.value === value);
  /** The model it runs, chosen or not, if known: whose efforts it offers. */
  const runs = named(settings.model ?? defaults.model);
  const efforts = runs?.efforts ?? [];
  const startable =
    connection === 'terminal' || connection === 'codex-terminal'
      ? STARTING_MODES[connection]
      : cycledModes(agent);
  const chosenMode =
    settings.mode !== undefined && startable.includes(settings.mode) ? settings.mode : undefined;

  /** What each is named: its own name; '' for a default not known. */
  const modelName = (value: string | null) =>
    value === null ? '' : (named(value)?.label ?? value);
  const effortName = (value: string | null) =>
    value === null
      ? ''
      : (efforts.find((e) => e.value === value)?.label ??
        value.charAt(0).toUpperCase() + value.slice(1));
  const modeName = (value: SessionMode | null) =>
    value === null ? '' : modeOf(agent, value).label;
  /** The effort it reasons at unless one is chosen: the user's own, if its model has it. */
  const defaultEffort =
    (efforts.some((e) => e.value === defaults.effort) ? defaults.effort : null) ??
    runs?.defaultEffort ??
    null;
  /** The user's own, as a menu offers it: "Default (Opus)", or "Default" where unknown. */
  const yours = (name: string) =>
    name === '' || name === 'Default' ? 'Default' : `Default (${name})`;
  const shown = {
    model:
      settings.model === undefined ? yours(modelName(defaults.model)) : modelName(settings.model),
    effort:
      settings.effort === undefined
        ? yours(effortName(defaultEffort))
        : effortName(settings.effort),
    mode: chosenMode === undefined ? yours(modeName(defaults.mode)) : modeName(chosenMode),
  };
  /** What it starts with, chosen or not, as the button says it. */
  const summary = [
    modelName(settings.model ?? defaults.model) || 'Default model',
    effortName(settings.effort ?? defaultEffort),
    modeName(chosenMode ?? defaults.mode),
  ]
    .filter((part) => part !== '')
    .join(' · ');
  /** Whether the session that runs started with other settings than these. */
  const stale = running !== undefined && !sameSettings(running, settings);

  /** Sets one of them (DEFAULT: the user's own). An effort the new model lacks goes. */
  const set = (key: keyof AgentSettings, value: string) => {
    const given = value === DEFAULT ? undefined : value;
    const next = withSetting(settings, key, given);
    const offered = named(next.model ?? defaults.model)?.efforts;
    if (key === 'model' && offered && !offered.some((e) => e.value === next.effort)) {
      onChange?.(withSetting(next, 'effort', undefined));
    } else onChange?.(next);
  };

  return (
    <div
      className={inline ? 'agent-settings-inline' : 'agent-settings'}
      onBlur={(event) => {
        if (!inline && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        // Esc closes the panel, not the view.
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {!inline && (
        <button
          type="button"
          className="agent-settings-button"
          aria-label={label ?? `Settings: ${summary}`}
          aria-expanded={open}
          title={`What ${words.name} starts with`}
          onClick={() => {
            if (onOpen) onOpen();
            else setOpen(!open);
          }}
        >
          {prefix}
          {summary}
          {suffix}
        </button>
      )}
      {(inline || open) && (
        <div
          className={inline ? 'agent-settings-fields' : 'agent-settings-panel'}
          role={inline ? 'group' : 'dialog'}
          aria-label={`${words.name} settings`}
        >
          <p className="agent-settings-title">{words.name} starts with</p>
          <div className="agent-settings-row">
            <span>Model</span>
            <ChoiceMenu
              label="Model"
              value={shown.model}
              title={`The model ${words.name} starts with`}
              below
              choices={[
                {
                  key: DEFAULT,
                  label: yours(modelName(defaults.model)),
                  detail: defaults.model === null ? words.its : words.yours,
                },
                ...models.map((m) => ({
                  key: m.value,
                  label: m.label,
                  ...(m.description === undefined ? {} : { detail: m.description }),
                })),
                ...(settings.model !== undefined && !named(settings.model)
                  ? [{ key: settings.model, label: settings.model }]
                  : []),
              ]}
              chosen={settings.model ?? DEFAULT}
              onChoose={(key) => {
                set('model', key);
              }}
            />
          </div>
          {(efforts.length > 0 || settings.effort !== undefined) && (
            <div className="agent-settings-row">
              <span>Effort</span>
              <ChoiceMenu
                label="Effort"
                value={shown.effort}
                title="How hard the model reasons"
                below
                choices={[
                  {
                    key: DEFAULT,
                    label: yours(effortName(defaultEffort)),
                    detail: defaults.effort === null ? 'The model’s own' : words.yours,
                  },
                  ...efforts.map((e) => ({
                    key: e.value,
                    label: e.label,
                    ...(e.description === undefined ? {} : { detail: e.description }),
                  })),
                ]}
                chosen={settings.effort ?? DEFAULT}
                onChoose={(key) => {
                  set('effort', key);
                }}
              />
            </div>
          )}
          <div className="agent-settings-row">
            <span>Mode</span>
            <ChoiceMenu
              label="Mode"
              value={shown.mode}
              title={`The mode ${words.name} starts in`}
              below
              choices={[
                {
                  key: DEFAULT,
                  label: yours(modeName(defaults.mode)),
                  detail: defaults.mode === null ? words.its : words.yours,
                },
                ...startable.map((m) => {
                  const info = modeOf(agent, m);
                  return { key: m, label: info.label, detail: info.description };
                }),
              ]}
              chosen={chosenMode ?? DEFAULT}
              onChoose={(key) => {
                set('mode', key);
              }}
            />
          </div>
          {read.problem !== undefined && (
            <p className="agent-settings-problem" role="alert">
              {read.problem}
            </p>
          )}
          {stale && (
            <p className="agent-settings-restart">
              {words.name} started with other settings.
              <button
                type="button"
                disabled={working}
                title={
                  working
                    ? 'Once it is done working'
                    : `Starts ${words.name} again with these, resuming this conversation`
                }
                onClick={onRestart}
              >
                Restart with these
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Whether two settings set the same. */
function sameSettings(a: AgentSettings, b: AgentSettings): boolean {
  return a.model === b.model && a.effort === b.effort && a.mode === b.mode;
}

/** `settings` with `key` set to `value` (undefined: not set, the user's own). */
function withSetting(
  settings: AgentSettings,
  key: keyof AgentSettings,
  value: string | undefined,
): AgentSettings {
  const next: AgentSettings = { ...settings };
  if (key === 'model') delete next.model;
  else if (key === 'effort') delete next.effort;
  else delete next.mode;
  if (value === undefined) return next;
  return key === 'mode' ? { ...next, mode: value as SessionMode } : { ...next, [key]: value };
}
