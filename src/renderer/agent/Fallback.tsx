import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { connectionIn } from '../../shared/adapter';
import type { AgentId } from '../../shared/api/ids';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { AgentNode, CanvasNode } from '../../shared/model/canvas';
import { setFallback as validateFallback } from '../../shared/model/agent-ops';
import { agentEndpoint } from '../../shared/model/catalog';
import { endpointOf, HandoffInputSchema } from '../../shared/model/fallback';
import type { FallbackStep, FallbackInput } from '../../shared/model/fallback';
import type { AgentSettings, SettingsOptions } from '../../shared/session';
import { useSessionSummaries } from '../api/runtime';
import type { TopicMirror } from '../api/topics';
import { catalog } from '../catalog';
import { agentLabel } from '../graph/agents';
import { ipcErrorMessage } from '../ipc-error';
import { sessionOptions } from '../run/sessions';
import './Fallback.css';

interface ContextValue {
  canvas: CanvasId;
  client: GuiApi;
  nodes: ReadonlyMap<string, AgentNode>;
  summaries: ReturnType<typeof useSessionSummaries>;
  inert: boolean;
}
const Context = createContext<ContextValue | null>(null);

/** Reads the core's metadata, shared by cards, lanes and both chain-picker entry points. */
export function FallbackProvider({
  children,
  canvas,
  client,
  mirror,
  nodes,
  inert = false,
}: {
  canvas: CanvasId;
  client: GuiApi;
  mirror: TopicMirror;
  nodes: readonly CanvasNode[];
  inert?: boolean | undefined;
  children: ReactNode;
}) {
  const summaries = useSessionSummaries(canvas, mirror);
  const agents = useMemo(
    () =>
      new Map(nodes.flatMap((node) => (node.type === 'agent' ? [[node.id, node] as const] : []))),
    [nodes],
  );
  return <Context value={{ canvas, client, nodes: agents, summaries, inert }}>{children}</Context>;
}
function useAgent(agent: string) {
  const context = useContext(Context);
  const node = context?.nodes.get(agent);
  return { context, node, summary: context?.summaries?.[agent as AgentId] };
}
function endpointName(step: FallbackStep): string {
  return [agentLabel(step.adapter, step.connection), step.model, step.effort]
    .filter(Boolean)
    .join(' · ');
}

/** The same picker lives beside the chip in the window and the settings sheet. */
export function ChainControl({ agent }: { agent: string }) {
  const { context, node, summary } = useAgent(agent);
  const scope = `${context?.canvas ?? ''}/${agent}`;
  const [opened, setOpened] = useState<string>();
  if (opened !== undefined && opened !== scope) setOpened(undefined);
  const open = opened === scope;
  const setOpen = (next: boolean) => {
    setOpened(next ? scope : undefined);
  };
  const own = node && (node.data.fallback?.on?.from ?? endpointOf(node.data, catalog()));
  if (!context || !node || !own || agentEndpoint(node.data, catalog()).kind !== 'known')
    return null;
  return (
    <>
      <button
        type="button"
        className="fallback-control"
        aria-label="Fallback chain"
        disabled={context.inert}
        onClick={() => {
          setOpen(true);
        }}
      >
        {node.data.fallback ? (
          <>
            <span data-current={summary?.fallback?.step == null ? '' : undefined}>
              {endpointName(own)}
            </span>
            {node.data.fallback.to.map((step, index) => (
              <span key={index}>
                {' '}
                →{' '}
                <span data-current={summary?.fallback?.step === index ? '' : undefined}>
                  {endpointName(step)}
                </span>
              </span>
            ))}
          </>
        ) : (
          'Fallback chain…'
        )}
      </button>
      {open && (
        <ChainPicker
          context={context}
          node={node}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="fallback-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="fallback-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
              ),
            ];
            const first = items[0],
              last = items.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === panel.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === panel.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ChainPicker({
  context,
  node,
  onClose,
}: {
  context: ContextValue;
  node: AgentNode;
  onClose: () => void;
}) {
  const [steps, setSteps] = useState<FallbackStep[]>(() =>
    structuredClone(node.data.fallback?.to ?? []),
  );
  const [back, setBack] = useState(node.data.fallback?.back === 'return');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const locked = useRef(false);
  const own = node.data.fallback?.on?.from ?? endpointOf(node.data, catalog());
  const input: FallbackInput | null =
    steps.length === 0 ? null : { to: steps, ...(back ? { back: 'return' as const } : {}) };
  let valid = true;
  try {
    validateFallback(
      { id: context.canvas, arrange: false, nodes: [node], links: [] },
      { agent: node.id, fallback: input },
      { catalog: catalog() },
    );
  } catch {
    valid = false;
  }
  const save = async () => {
    if (locked.current || context.inert || !valid) return;
    locked.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await context.client.agentSetFallback({
        canvas: context.canvas,
        agent: node.id,
        fallback: input,
      });
      onClose();
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const current = context.summaries?.[node.id as AgentId]?.fallback;
  return (
    <Dialog
      title="Fallback chain"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        When usage runs out, carry on with these backends in order. Each starts a fresh conversation
        with the task and the latest handoff.
      </p>
      {own && (
        <p>
          Own endpoint: {endpointName(own)}
          {current?.step == null ? ' · current' : ''}
        </p>
      )}
      {steps.map((step, index) => (
        <StepEditor
          key={index}
          context={context}
          agent={node.id}
          step={step}
          settings={node.data.settings?.[step.adapter]}
          index={index}
          busy={busy}
          current={current?.step === index}
          onChange={(next) => {
            setSteps(steps.map((one, at) => (at === index ? next : one)));
          }}
          onMove={(delta) => {
            const target = index + delta;
            const neighbor = steps[target];
            if (!neighbor) return;
            setSteps(
              steps.map((one, at) => (at === target ? step : at === index ? neighbor : one)),
            );
          }}
          canMoveDown={index < steps.length - 1}
          onRemove={() => {
            setSteps(steps.filter((_, at) => at !== index));
          }}
        />
      ))}
      <button
        type="button"
        disabled={busy || steps.length >= 3}
        onClick={() => {
          setSteps([...steps, { adapter: '', connection: '' }]);
        }}
      >
        Add step
      </button>
      {!valid && (
        <p>Choose up to three available, distinct endpoints, different from the own endpoint.</p>
      )}
      <label>
        <input
          type="checkbox"
          checked={back}
          disabled={busy}
          onChange={(event) => {
            setBack(event.target.checked);
          }}
        />
        Return when its own usage resets
      </label>
      <p>
        Otherwise it stays on the last backend used. A return happens at the next task and never
        interrupts a turn.
      </p>
      <p>
        Each target uses its own login and permission settings. Its first turn may wait for your
        consent. Saving this chain grants no consent and starts nothing. The task, handoff and
        worktree go to the backend you choose.
      </p>
      {problem && <p role="alert">{problem}</p>}
      <footer>
        <button
          type="button"
          disabled={busy || !valid || context.inert}
          onClick={() => {
            void save();
          }}
        >
          Save chain
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}

function StepEditor({
  context,
  agent,
  step,
  settings,
  index,
  busy,
  current,
  onChange,
  onRemove,
  onMove,
  canMoveDown,
}: {
  context: ContextValue;
  agent: string;
  step: FallbackStep;
  settings: AgentSettings | undefined;
  index: number;
  busy: boolean;
  current: boolean;
  onChange: (step: FallbackStep) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  canMoveDown: boolean;
}) {
  const [read, setRead] = useState<{
    adapter: string;
    options?: SettingsOptions;
    problem?: string;
  }>();
  const options = read?.adapter === step.adapter ? read.options : undefined;
  const problem = read?.adapter === step.adapter ? read.problem : undefined;
  const prefix = `Step ${String(index + 1)}`;
  const adapter = catalog().adapters.find((one) => one.id === step.adapter);
  const connection = adapter?.connections.find((one) => one.id === step.connection);
  useEffect(() => {
    let live = true;
    if (adapter)
      void sessionOptions(context.client, context.canvas, step.adapter, agent).then(
        (given) => {
          if (live) setRead({ adapter: step.adapter, options: given });
        },
        (error: unknown) => {
          if (live) setRead({ adapter: step.adapter, problem: ipcErrorMessage(error) });
        },
      );
    return () => {
      live = false;
    };
  }, [adapter, agent, context.canvas, context.client, step.adapter]);
  const models = options?.models ?? [];
  const efforts =
    models.find(
      (model) => model.value === (step.model ?? settings?.model ?? options?.defaults.model),
    )?.efforts ?? [];
  return (
    <fieldset disabled={busy}>
      <legend>
        {prefix}
        {current ? ' · current' : ''}
      </legend>
      <label>
        Agent
        <select
          aria-label={`${prefix} agent`}
          value={step.adapter}
          onChange={(event) => {
            const next = catalog().adapters.find((one) => one.id === event.target.value);
            const first = next?.connections[0];
            if (next && first) onChange({ adapter: next.id, connection: first.id });
          }}
        >
          {!adapter && (
            <option value={step.adapter}>
              {step.adapter ? `${step.adapter} · unavailable` : 'Choose an agent'}
            </option>
          )}
          {catalog().adapters.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Connection
        <select
          aria-label={`${prefix} connection`}
          value={step.connection}
          onChange={(event) => {
            onChange({ ...step, connection: event.target.value });
          }}
        >
          {!connection && (
            <option value={step.connection}>
              {step.connection ? `${step.connection} · unavailable` : 'Choose a connection'}
            </option>
          )}
          {adapter?.connections.map((one) => (
            <option key={one.id} value={one.id}>
              {one.label}
            </option>
          ))}
        </select>
      </label>
      {connection && (
        <p>
          {connection.description}
          {connection.usage === null ? ' · never falls back on its own' : ''}
        </p>
      )}
      <label>
        Model
        <select
          aria-label={`${prefix} model`}
          value={step.model ?? ''}
          onChange={(event) => {
            const endpoint = { ...step };
            delete endpoint.model;
            delete endpoint.effort;
            onChange({ ...endpoint, ...(event.target.value ? { model: event.target.value } : {}) });
          }}
        >
          <option value="">Saved model or native default</option>
          {step.model && !models.some((one) => one.value === step.model) && (
            <option value={step.model}>{step.model}</option>
          )}
          {models.map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select
          aria-label={`${prefix} effort`}
          value={step.effort ?? ''}
          onChange={(event) => {
            const endpoint = { ...step };
            delete endpoint.effort;
            onChange({
              ...endpoint,
              ...(event.target.value ? { effort: event.target.value } : {}),
            });
          }}
        >
          <option value="">Saved effort or native default</option>
          {step.effort && !efforts.some((one) => one.value === step.effort) && (
            <option value={step.effort}>{step.effort}</option>
          )}
          {efforts.map((one) => (
            <option key={one.value} value={one.value}>
              {one.label}
            </option>
          ))}
        </select>
      </label>
      {problem && <p role="alert">{problem}</p>}
      <button
        type="button"
        disabled={index === 0}
        aria-label={`Move step ${String(index + 1)} up`}
        onClick={() => {
          onMove(-1);
        }}
      >
        Move up
      </button>
      <button
        type="button"
        disabled={!canMoveDown}
        aria-label={`Move step ${String(index + 1)} down`}
        onClick={() => {
          onMove(1);
        }}
      >
        Move down
      </button>
      <button type="button" aria-label={`Remove step ${String(index + 1)}`} onClick={onRemove}>
        Remove
      </button>
    </fieldset>
  );
}

/** A compact mark beside existing status: the core decides position and switching. */
export function FallbackMark({ agent, card = false }: { agent: string; card?: boolean }) {
  const { node, summary } = useAgent(agent);
  const view = summary?.fallback;
  if (!node || !view) return null;
  const current = view.step === null ? undefined : node.data.fallback?.to[view.step];
  const remaining = view.steps - (view.step === null ? 0 : view.step + 1);
  const own = view.from ?? endpointOf(node.data, catalog());
  const text = view.switching
    ? 'Switching…'
    : `${current ? endpointName(current) : 'Own endpoint'} · ${String(remaining)} next`;
  return (
    <span
      className="fallback-mark"
      aria-label="Fallback status"
      title={[
        text,
        ...(own ? [endpointName(own)] : []),
        ...(node.data.fallback?.to.map(endpointName) ?? []),
      ].join(' → ')}
    >
      {card ? (
        <>
          <span aria-hidden="true">{view.switching ? '…' : `↪ ${String(remaining)}`}</span>
          <span className="fallback-sr">{text}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

const HANDOFF_WORDS = {
  kept: 'Latest handoff kept',
  asking: 'Asking for a handoff…',
  failed:
    'Handoff not accepted. Requests are limited to twice per crossing; a previous handoff stays the latest.',
  unreported: 'Context not reported. No handoff is requested.',
  off: 'Handoffs off',
};
/** Metadata only until an explicit read; export paths are edited only through setHandoff. */
export function HandoffTile({ agent }: { agent: string }) {
  const { context, node, summary } = useAgent(agent);
  const scope = `${context?.canvas ?? ''}/${agent}`;
  const [opening, setOpening] = useState<{ scope: string; kind: 'settings' | 'text' }>();
  if (opening && opening.scope !== scope) setOpening(undefined);
  const opened = opening?.scope === scope ? opening.kind : undefined;
  const setOpened = (kind: 'settings' | 'text' | undefined) => {
    setOpening(kind ? { scope, kind } : undefined);
  };
  if (!context || !node) return null;
  const view = summary?.handoff;
  const endpoint = agentEndpoint(node.data, catalog());
  const reports =
    endpoint.kind === 'known' && connectionIn(catalog(), endpoint.connection)?.connection.context;
  const state =
    view?.state ?? (node.data.handoff?.off ? 'off' : reports ? undefined : 'unreported');
  return (
    <section className="handoff-tile" aria-label="Handoff" data-state={state}>
      <header>
        <h3>Handoff</h3>
        <button
          type="button"
          aria-label="Handoff settings"
          disabled={context.inert}
          onClick={() => {
            setOpened('settings');
          }}
        >
          ⚙
        </button>
      </header>
      <p>
        {state
          ? HANDOFF_WORDS[state]
          : `Waiting for context to reach ${String(node.data.handoff?.at ?? 95)}%.`}
      </p>
      {view?.at != null && (
        <p>
          {new Date(view.at).toLocaleString()} · {String(view.bytes)} bytes
        </p>
      )}
      {view && <p>Export {view.export}</p>}
      {view?.at != null && (
        <button
          type="button"
          disabled={context.inert}
          onClick={() => {
            setOpened('text');
          }}
        >
          Read handoff
        </button>
      )}
      <p>
        Asked after a turn, before compaction where reported. A lowered compaction setting, idle
        compaction or a large tool output can come first. The previous handoff stays the latest; the
        next crossing asks again.
      </p>
      {opened === 'settings' && (
        <HandoffSettings
          context={context}
          node={node}
          onClose={() => {
            setOpened(undefined);
          }}
        />
      )}
      {opened === 'text' && (
        <HandoffText
          context={context}
          agent={agent}
          onClose={() => {
            setOpened(undefined);
          }}
        />
      )}
    </section>
  );
}
function HandoffSettings({
  context,
  node,
  onClose,
}: {
  context: ContextValue;
  node: AgentNode;
  onClose: () => void;
}) {
  const [on, setOn] = useState(!node.data.handoff?.off);
  const [at, setAt] = useState(String(node.data.handoff?.at ?? 95));
  const [file, setFile] = useState(node.data.handoff?.file ?? '');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [problem, setProblem] = useState<string>();
  const value = { ...(!on ? { off: true as const } : {}), at: Number(at), file: file || null };
  const valid = HandoffInputSchema.safeParse(value).success;
  const save = async (defaults = false) => {
    if (locked.current || context.inert) return;
    locked.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      await context.client.agentSetHandoff({
        canvas: context.canvas,
        agent: node.id,
        handoff: defaults ? null : value,
      });
      onClose();
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Handoff settings"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(event) => {
            setOn(event.target.checked);
          }}
        />
        Write handoffs
      </label>
      <label>
        Ask at context percent
        <input
          type="number"
          aria-label="Ask at context percent"
          min={10}
          max={95}
          step={1}
          value={at}
          disabled={busy}
          onChange={(event) => {
            setAt(event.target.value);
          }}
        />
      </label>
      <label>
        Markdown export
        <input
          aria-label="Markdown export"
          value={file}
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.value);
          }}
          placeholder="notes/handoff.md"
        />
      </label>
      <p>
        Optional relative .md file in this agent’s checkout. Its parent must exist. corrallm
        replaces only this agent’s unchanged last export, follows no symlinks and never retries a
        refused or failed export.
      </p>
      {!valid && <p>Use a whole percent from 10 to 95 and a relative Markdown path.</p>}
      {problem && <p role="alert">{problem}</p>}
      <footer>
        <button
          type="button"
          disabled={busy || !valid || context.inert}
          onClick={() => {
            void save();
          }}
        >
          Save handoff settings
        </button>
        <button
          type="button"
          disabled={busy || context.inert}
          onClick={() => {
            void save(true);
          }}
        >
          Use handoff defaults
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}
function HandoffText({
  context,
  agent,
  onClose,
}: {
  context: ContextValue;
  agent: string;
  onClose: () => void;
}) {
  const initial = useRef<ReturnType<GuiApi['sessionHandoff']> | undefined>(undefined);
  const [value, setValue] = useState<Awaited<ReturnType<GuiApi['sessionHandoff']>>>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let live = true;
    initial.current ??= context.client.sessionHandoff({ canvas: context.canvas, agent });
    void initial.current.then(
      (value) => {
        if (live) setValue(value);
      },
      (error: unknown) => {
        if (live) setProblem(ipcErrorMessage(error));
      },
    );
    return () => {
      live = false;
    };
  }, [agent, context.canvas, context.client]);
  const handoff = value?.handoff;
  return (
    <Dialog title="Latest handoff" onClose={onClose}>
      {problem && <p role="alert">{problem}</p>}
      {!value && !problem && <p>Reading…</p>}
      {value && !handoff && <p>No handoff kept yet.</p>}
      {handoff && (
        <>
          <p>
            {endpointName(handoff.source)} · {new Date(handoff.at).toLocaleString()} ·{' '}
            {String(handoff.bytes)} bytes
          </p>
          <pre>{handoff.text}</pre>
        </>
      )}
    </Dialog>
  );
}
