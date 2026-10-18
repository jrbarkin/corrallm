import { useEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { usageBackendIn } from '../../shared/adapter';
import type { UsageBackendId } from '../../shared/adapter';
import { USAGE_ACTIONS, USAGE_WINDOWS, usageOver, WINDOW_NAMES } from '../../shared/usage';
import type {
  UsageAction,
  UsageReading,
  UsageRule,
  UsageState,
  UsageWindow,
  UsageWindows,
} from '../../shared/usage';
import { catalog } from '../catalog';
import { runCatalog } from '../graph/agents';
import { parseTime } from '../graph/time';
import { SearchPicker } from '../search/SearchPicker';
import { ACTION_INFO, ageText, percentText, readingOf, resetTime, windowText } from './usage';
import './Usage.css';

/** A reading older than this says how old it is on its gauge, not only in its panel. */
const STALE_MS = 15 * 60_000;
/** The shares a rule offers before anything is typed. */
const PERCENTS = [50, 60, 70, 75, 80, 85, 90, 95];
/** A new rule's share and window, until changed. */
const NEW_RULE = { window: 'fiveHour', percent: 80 } as const;

const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The time now, again every `ms`, for what says how long ago or how soon. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(timer);
    };
  }, [ms]);
  return now;
}

/**
 * A usage gauge for each backend the canvas's agents use (usage/usage.ts backendsOf): how much of
 * each window its latest reading says is used, amber past its rule's share. A click opens its
 * panel: each window with when it resets, how old the reading is, where readings come from, the
 * backend's usage rule (set here), and Simulate usage….
 */
export function UsageGauges({
  backends,
  usage,
  onRule,
  onSimulate,
}: {
  backends: readonly UsageBackendId[];
  usage: UsageState;
  onRule: (backend: UsageBackendId, rule: UsageRule | null) => void;
  onSimulate: (backend: UsageBackendId, windows: UsageWindows | null) => void;
}) {
  const now = useNow();
  if (backends.length === 0) return null;
  return (
    <div className="usage-gauges">
      {backends.map((backend) => (
        <UsageGauge
          key={backend}
          backend={backend}
          reading={readingOf(usage, backend)}
          rule={usage.rules[backend]}
          now={now}
          onRule={(rule) => {
            onRule(backend, rule);
          }}
          onSimulate={(windows) => {
            onSimulate(backend, windows);
          }}
        />
      ))}
    </div>
  );
}

/** The windows of a reading that still count (not reset since), in order. */
function counting(reading: UsageReading | undefined, now: number) {
  return USAGE_WINDOWS.flatMap((window) => {
    const used = reading?.windows[window];
    if (!used || (used.resetsAt !== null && used.resetsAt <= now)) return [];
    return [{ window, ...used }];
  });
}

function UsageGauge({
  backend,
  reading,
  rule,
  now,
  onRule,
  onSimulate,
}: {
  backend: UsageBackendId;
  reading: UsageReading | undefined;
  rule: UsageRule | undefined;
  now: number;
  onRule: (rule: UsageRule | null) => void;
  onSimulate: (windows: UsageWindows | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const name = runCatalog().backendName(backend);
  const windows = counting(reading, now);
  const over = rule !== undefined && usageOver(reading, rule.window, rule.percent, now);
  const stale = reading !== undefined && now - reading.at > STALE_MS;
  // A reading whose every window has reset since says so, and how old it is.
  const none = reading === undefined ? 'no reading' : 'reset since read';
  const summary =
    windows.length === 0
      ? none
      : windows
          .map(({ window, usedPercent }) => `${percentText(usedPercent)} of ${windowText(window)}`)
          .join(', ');

  // A click outside closes it, as Escape does.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className="usage-gauge-root"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="usage-gauge"
        aria-label={`${name} usage: ${summary}`}
        aria-expanded={open}
        title={`${name}’s usage limits, its usage rule, and simulating usage`}
        data-over={over ? '' : undefined}
        data-stale={stale ? '' : undefined}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="usage-name">{name}</span>
        {windows.length === 0 && <span className="usage-none">{none}</span>}
        {windows.map(({ window, usedPercent }) => (
          <span
            key={window}
            className="usage-window"
            data-over={over && rule.window === window ? '' : undefined}
            title={`${percentText(usedPercent)} of the ${windowText(window)} used`}
          >
            <Meter used={usedPercent} />
            {percentText(usedPercent)}
            <span className="usage-window-name">{WINDOW_NAMES[window]}</span>
          </span>
        ))}
        {reading?.simulated && <span className="usage-tag">simulated</span>}
        {stale && <span className="usage-age">{ageText(reading.at, now)}</span>}
      </button>
      {open && (
        <UsagePanel
          backend={backend}
          reading={reading}
          rule={rule}
          now={now}
          onRule={onRule}
          onSimulate={onSimulate}
        />
      )}
    </div>
  );
}

function Meter({ used }: { used: number }) {
  return (
    <span className="usage-meter" aria-hidden="true">
      <span className="usage-fill" style={{ width: `${String(Math.min(100, used))}%` }} />
    </span>
  );
}

function UsagePanel({
  backend,
  reading,
  rule,
  now,
  onRule,
  onSimulate,
}: {
  backend: UsageBackendId;
  reading: UsageReading | undefined;
  rule: UsageRule | undefined;
  now: number;
  onRule: (rule: UsageRule | null) => void;
  onSimulate: (windows: UsageWindows | null) => void;
}) {
  const [simulating, setSimulating] = useState(false);
  const name = runCatalog().backendName(backend);
  return (
    <div className="usage-panel" role="dialog" aria-label={`${name} usage`}>
      <p className="usage-panel-title">
        <strong>{name} usage</strong>
        <span className="usage-panel-age">
          {reading === undefined
            ? 'Not read yet'
            : `${reading.simulated ? 'Simulated' : 'Read'} ${ageText(reading.at, now)}`}
        </span>
      </p>
      <ul className="usage-panel-windows">
        {USAGE_WINDOWS.map((window) => {
          const used = reading?.windows[window];
          const reset = used?.resetsAt ?? null;
          const past = reset !== null && reset <= now;
          const over = rule?.window === window && usageOver(reading, window, rule.percent, now);
          return (
            <li key={window} data-over={over ? '' : undefined}>
              <span className="usage-panel-window">{upper(windowText(window))}</span>
              {used && !past ? (
                <>
                  <Meter used={used.usedPercent} />
                  <span>
                    {percentText(used.usedPercent)} used
                    {reset === null ? '' : ` · resets ${resetTime(reset, now)}`}
                  </span>
                </>
              ) : (
                <span className="usage-none">
                  {past ? `Reset ${resetTime(reset, now)}; not read since` : 'Not read'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="usage-panel-note">{usageBackendIn(catalog(), backend)?.source}</p>
      <RuleEditor rule={rule} onRule={onRule} />
      {simulating ? (
        <SimulateForm
          backend={backend}
          onSimulate={(windows) => {
            onSimulate(windows);
            setSimulating(false);
          }}
          onCancel={() => {
            setSimulating(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="usage-panel-simulate"
          onClick={() => {
            setSimulating(true);
          }}
        >
          Simulate usage…
        </button>
      )}
    </div>
  );
}

/** Which of a rule's chips is open. */
type Editing = 'action' | 'percent' | 'window' | undefined;

/**
 * A backend's usage rule, in words, each part a chip that changes it: "Usage rule: over [80%] of
 * the [5-hour window]: [Pause and ask me]", with × to take it off; or, with none, Add a rule….
 */
function RuleEditor({
  rule,
  onRule,
}: {
  rule: UsageRule | undefined;
  onRule: (rule: UsageRule | null) => void;
}) {
  const [editing, setEditing] = useState<Editing>();
  const close = () => {
    setEditing(undefined);
  };
  const chip = (which: Exclude<Editing, undefined>, label: string, text: string) => (
    <button
      type="button"
      className="graph-queue-target"
      aria-label={label}
      aria-expanded={editing === which}
      onClick={() => {
        setEditing(editing === which ? undefined : which);
      }}
    >
      {text}
    </button>
  );
  return (
    <div className="usage-rule">
      <span className="usage-rule-label">Usage rule</span>
      {rule ? (
        <>
          <span>over</span>
          {chip(
            'percent',
            `Change the share: ${String(rule.percent)}%`,
            `${String(rule.percent)}%`,
          )}
          <span>of the</span>
          {chip('window', `Change the window: ${windowText(rule.window)}`, windowText(rule.window))}
          {chip(
            'action',
            `Change what happens: ${ACTION_INFO[rule.action].label}`,
            ACTION_INFO[rule.action].label,
          )}
          <button
            type="button"
            className="usage-rule-remove"
            aria-label="Take the usage rule off"
            title="Take the usage rule off"
            onClick={() => {
              onRule(null);
            }}
          />
        </>
      ) : (
        <button
          type="button"
          className="usage-rule-add"
          aria-expanded={editing === 'action'}
          onClick={() => {
            setEditing(editing === 'action' ? undefined : 'action');
          }}
        >
          Add a rule…
        </button>
      )}
      {editing === 'action' && (
        <SearchPicker
          label={
            rule ? 'When usage is over the share…' : 'When usage is over 80% of the 5-hour window…'
          }
          options={USAGE_ACTIONS}
          optionLabel={(action: UsageAction) => ACTION_INFO[action].label}
          optionDetail={(action: UsageAction) => ACTION_INFO[action].detail}
          optionKey={String}
          onPick={(action) => {
            onRule({ ...(rule ?? NEW_RULE), action });
            close();
          }}
          onCancel={close}
        />
      )}
      {editing === 'percent' && rule && (
        <SearchPicker
          label="Over what share?"
          placeholder="80, 90…"
          options={PERCENTS}
          optionLabel={(percent) => `${String(percent)}%`}
          optionKey={String}
          typed={(query) => {
            const percent = Number(/^\s*(\d+)\s*%?\s*$/.exec(query)?.[1]);
            return Number.isInteger(percent) && percent >= 1 && percent <= 99 ? [percent] : [];
          }}
          onPick={(percent) => {
            onRule({ ...rule, percent });
            close();
          }}
          onCancel={close}
        />
      )}
      {editing === 'window' && rule && (
        <SearchPicker
          label="Of which window?"
          options={USAGE_WINDOWS}
          optionLabel={(window: UsageWindow) => windowText(window)}
          optionKey={String}
          onPick={(window) => {
            onRule({ ...rule, window });
            close();
          }}
          onCancel={close}
        />
      )}
    </div>
  );
}

/** A window's simulated share and reset, as typed. */
interface Typed {
  used: string;
  resetsIn: string;
}

/**
 * Simulates a backend's usage, to try its rule, Ifs and waits without spending real usage: how
 * much of each window is used (left empty: not read), and how long until it resets ("2 hours").
 * Clear forgets the backend's reading.
 */
function SimulateForm({
  backend,
  onSimulate,
  onCancel,
}: {
  backend: UsageBackendId;
  onSimulate: (windows: UsageWindows | null) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState<Record<UsageWindow, Typed>>({
    fiveHour: { used: '85', resetsIn: '2 hours' },
    weekly: { used: '30', resetsIn: '3 days' },
  });
  const [problem, setProblem] = useState<string>();
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const windows: UsageWindows = {};
    for (const window of USAGE_WINDOWS) {
      const { used, resetsIn } = typed[window];
      if (used.trim() === '') continue;
      const percent = Number(used);
      const length = parseTime(resetsIn).find((time) => 'seconds' in time);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        setProblem(`The ${WINDOW_NAMES[window]} share must be from 0 to 100.`);
        return;
      }
      if (!length || !('seconds' in length)) {
        setProblem(`Type how long until the ${WINDOW_NAMES[window]} window resets, e.g. 2 hours.`);
        return;
      }
      windows[window] = { usedPercent: percent, resetsAt: Date.now() + length.seconds * 1000 };
    }
    onSimulate(Object.keys(windows).length === 0 ? null : windows);
  };
  return (
    <form
      className="usage-simulate"
      aria-label={`Simulate ${runCatalog().backendName(backend)}’s usage`}
      onSubmit={submit}
    >
      {USAGE_WINDOWS.map((window) => (
        <p key={window}>
          <span className="usage-panel-window">{upper(windowText(window))}</span>
          <input
            aria-label={`${windowText(window)}: share used (%)`}
            inputMode="decimal"
            size={3}
            value={typed[window].used}
            onChange={(event) => {
              setTyped({ ...typed, [window]: { ...typed[window], used: event.target.value } });
            }}
          />
          % · resets in
          <input
            aria-label={`${windowText(window)}: resets in`}
            size={8}
            value={typed[window].resetsIn}
            onChange={(event) => {
              setTyped({ ...typed, [window]: { ...typed[window], resetsIn: event.target.value } });
            }}
          />
        </p>
      ))}
      {problem !== undefined && (
        <p className="usage-simulate-problem" role="alert">
          {problem}
        </p>
      )}
      <p className="usage-simulate-actions">
        <button type="submit" data-primary="">
          Simulate
        </button>
        <button
          type="button"
          title={`Forget ${runCatalog().backendName(backend)}’s reading`}
          onClick={() => {
            onSimulate(null);
          }}
        >
          Clear reading
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}
