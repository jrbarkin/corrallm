import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import type { Session } from '../agent/session';
import { AGENT_ACTIONS, CONNECTION_INFO, connectionOf, DEFAULT_AGENT } from '../graph/agents';
import { editsOf } from '../graph/edits';
import type { QueueEdits } from '../graph/edits';
import type { GraphNode } from '../graph/graph';
import { itemLabel, taskLabel } from '../graph/labels';
import { chooseTarget, findItem, isRepeat, isWait } from '../graph/queue';
import type { WaitTarget } from '../graph/queue';
import { PickTask, QueueAddMenu, QueueEnd, QueueRow } from '../graph/QueueEditor';
import type { Picking, RowMarks, StepChoice } from '../graph/QueueEditor';
import { useSortable } from '../graph/sortable';
import { heldAsks } from '../run/asks';
import type { HeldAsk } from '../run/asks';
import type { Run } from '../run/runner';
import { holdText } from '../usage/usage';
import { lanesOf } from './lanes';
import type { Lane, Lanes, Link } from './lanes';
import { queueMarks, taskKey as at } from './marks';
import { piecePaths, piecesIn, ribbonsOf } from './ribbons';
import type { Span } from './ribbons';
import './QueuesView.css';

/** How wide the gap between two lanes is, where ribbons join their tasks. */
const GAP = 64;

/**
 * What the run waits on the user for, in a lane: to decide at the hold its agent is at (an OK), to
 * answer its agent, which asks permission, or to switch an agent whose session would not start.
 */
type Needs = 'decide' | 'answer' | 'switch';

/** A wait whose target (in `choice`) is being picked: the agent whose queue it is in, `owner`. */
interface Choosing {
  owner: string;
  choice: StepChoice;
}

/**
 * Every agent's queue side by side, task by task, laid out like a diff viewer: each lane a pane of
 * its tasks, in rows aligned with the other lanes' so order reads downwards (lanes.ts). Where a
 * task sits in front of a task in another lane (a wait, after what it waits for), or hands work
 * to another agent, a ribbon in the gap between the lanes joins them (ribbons.ts), as a diff
 * viewer joins the blocks that differ; hatching shows where an agent waits, and waits in a loop
 * are stuck. Pointing at a task or a ribbon shows its links over the rest.
 *
 * Each lane is its agent's queue, the same queue as everywhere (QueueEditor.tsx's rows, edited
 * in place): a wait's step is picked by clicking it in its agent's lane. Run plays every queue
 * (run/runner.ts): the task each agent is on pulses, a wait or a delay it is held at breathes
 * (counting down to its time, with Go on now on hover), and what it has done is ticked. A wait
 * with a time limit has dashed edges: it may go on without what it waits for, so a loop of waits
 * that holds one is not stuck. At an OK the run waits for the user: the row pulses amber with how
 * to decide, and its lane's head says it needs you, taking you there. A queue stopped at an OK
 * stops whatever waits on it. Where a session would not start, the lane's head says why, and
 * offers to switch the agent (asks.ts). A repeat is one card in its lane, over the rows of what it holds,
 * each in its row: its round shows in a pill, and once out of rounds it asks, as an OK does.
 *
 * Opened from the canvas, or from an agent (`focus`, whose lane is brought into view). Escape, Back
 * or a click outside closes it; an agent's name opens that agent.
 */
export function QueuesView({
  nodes,
  sessions,
  run,
  edits,
  gauges,
  focus,
  backLabel,
  onRun,
  onStop,
  onOpenAgent,
  onClose,
}: {
  nodes: readonly GraphNode[];
  sessions: Readonly<Record<string, Session>>;
  run: Run;
  edits: QueueEdits;
  /** The usage gauges, in the header (UsageGauge.tsx). */
  gauges?: ReactNode;
  focus?: string;
  /** Where Back goes: "Canvas", or the agent it was opened from. */
  backLabel: string;
  onRun: () => void;
  onStop: () => void;
  onOpenAgent: (agentId: string) => void;
  onClose: () => void;
}) {
  const layout = useMemo(() => lanesOf(nodes), [nodes]);
  const { lanes, rows, links, isStuck } = layout;
  const grid = useRef<HTMLDivElement>(null);
  const name = (id: string) =>
    (nodes.find((n) => n.id === id)?.data.label ?? '') || 'Unnamed agent';
  const [choosing, setChoosing] = useState<Choosing>();

  // Escape lets go of a step being picked, then closes this, before whatever is under it hears it;
  // a dropdown open in a lane closes itself first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A dropdown, or a usage gauge's panel, closes itself first.
      if (
        event.target instanceof Element &&
        event.target.closest('.search-picker, .usage-panel, .usage-gauge[aria-expanded="true"]')
      ) {
        return;
      }
      event.stopPropagation();
      if (choosing) setChoosing(undefined);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose, choosing]);
  useEffect(() => {
    if (focus === undefined) return;
    [...(grid.current?.querySelectorAll<HTMLElement>('[data-lane]') ?? [])]
      .find((lane) => lane.dataset.lane === focus)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [focus]);

  // Where each task is (by `at`), down from the top of the rows: measured after every render, as
  // tasks change, and as the view resizes (text wraps anew); only a change re-renders.
  const [spans, setSpans] = useState<ReadonlyMap<string, Span>>(() => new Map());
  const measured = useRef('');
  const measure = () => {
    const root = grid.current;
    if (!root) return;
    const origin = (root.querySelector('.queues-gap') ?? root).getBoundingClientRect().top;
    const next = [...root.querySelectorAll<HTMLElement>('[data-at]')].map(
      (task): [string, Span] => {
        const box = task.getBoundingClientRect();
        // Ribbons meet a task along the straight part of its side, inside its rounded corners.
        const inset = Math.min(6, box.height / 4);
        const span = { top: box.top - origin + inset, bottom: box.bottom - origin - inset };
        return [task.dataset.at ?? '', span];
      },
    );
    const text = JSON.stringify(next);
    if (text === measured.current) return;
    measured.current = text;
    setSpans(new Map(next));
  };
  const remeasure = useRef(measure);
  useLayoutEffect(() => {
    remeasure.current = measure;
    measure();
  });
  useEffect(() => {
    const root = grid.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      remeasure.current();
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);
  const ribbons = ribbonsOf(layout, (end) => spans.get(at(end.lane, end.item)));

  /** What the pointer is on, a ribbon (its key) or a task (`at`): its links show over the rest. */
  const [pointed, setPointed] = useState<string | null>(null);
  const shown = links.filter((l) => l.key === pointed || ends(l).includes(pointed ?? ''));
  const active = new Set(shown.map((l) => l.key));
  const activeEnds = new Set(shown.flatMap(ends));
  const flowing = flowingWaits(layout, run);

  /** The agents asking permission: the run waits on the user for them. */
  const asking = new Set(
    lanes.flatMap(({ agent: { id } }) => (sessions[id]?.status === 'waiting' ? [id] : [])),
  );
  /** Every task's marks: where it is measured, how links mark it, and where the run is. */
  const marks = queueMarks(layout, run, asking, activeEnds);
  /** What the wait being picked waits for now, in the lane it is picked in: undefined for all. */
  const waitChosen = choosing
    ? findItem(nodes.find((n) => n.id === choosing.owner)?.data.queue ?? [], choosing.choice.waitId)
        ?.item
    : undefined;
  const choosingTarget =
    choosing && waitChosen && isWait(waitChosen)
      ? waitChosen.waitFor[choosing.choice.index]?.item
      : undefined;
  /** Sets the target being picked to a step of its agent, or (undefined) all of its work. */
  const pick = (item: string | undefined) => {
    if (!choosing) return;
    const { owner, choice } = choosing;
    setChoosing(undefined);
    const wait = findItem(nodes.find((n) => n.id === owner)?.data.queue ?? [], choice.waitId)?.item;
    if (!wait || !isWait(wait)) return;
    const target: WaitTarget =
      item === undefined ? { agent: choice.agent } : { agent: choice.agent, item };
    edits.setWaitFor(owner, wait.id, chooseTarget(wait.waitFor, choice.index, target));
  };

  /**
   * What the run waits on the user for, for an agent: to decide at the hold it is at (an OK, or a
   * repeat out of rounds), or to answer its agent, which asks permission in a task.
   */
  const needsYou = (id: string): Needs | undefined => {
    const status = run.running ? run.agents[id]?.status : undefined;
    return status === 'asking'
      ? run.agents[id]?.refused
        ? 'switch'
        : 'decide'
      : status === 'running' && asking.has(id)
        ? 'answer'
        : undefined;
  };
  /** What the run holds for the user: a session that would not start says so in its lane's head. */
  const asks = useMemo(() => heldAsks(nodes, run), [nodes, run]);
  const agents = Object.entries(run.agents);
  const count = (which: (id: string, status: string) => boolean) =>
    agents.filter(([id, a]) => which(id, a.status)).length;
  const needed = count((id) => needsYou(id) !== undefined);
  const stopped = count((_, status) => status === 'stopped');
  const runStatus = run.running
    ? [
        `${String(count((id, status) => status === 'running' && !needsYou(id)))} working`,
        `${String(count((_, status) => status === 'waiting'))} waiting`,
        ...(needed > 0 ? [`${String(needed)} need${needed === 1 ? 's' : ''} you`] : []),
        ...(stopped > 0 ? [`${String(stopped)} stopped`] : []),
      ].join(' · ')
    : agents.length === 0
      ? ''
      : agents.every(([, a]) => a.status === 'done')
        ? 'All done'
        : 'Stopped';

  return (
    <div
      className="graph-detail-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="queues-view" role="dialog" aria-modal="true" aria-label="All queues">
        <header className="agent-header">
          <button type="button" className="agent-back" aria-label="Back" onClick={onClose}>
            {backLabel}
          </button>
          <h2 className="queues-title">All queues</h2>
          <button
            type="button"
            className="queues-run"
            data-running={run.running ? '' : undefined}
            onClick={run.running ? onStop : onRun}
            title={run.running ? 'Stop every queue where it is' : 'Run every queue from the top'}
          >
            {run.running ? 'Stop' : 'Run'}
          </button>
          <span className="queues-run-status" role="status">
            {runStatus}
          </span>
          {gauges}
          <p className="queues-legend">
            <span className="queues-key" data-mark="wait">
              waits for
            </span>
            <span className="queues-key" data-mark="handoff">
              hands work to
            </span>
            <span className="queues-key" data-mark="stuck">
              stuck
            </span>
            <span className="queues-key" data-mark="ok">
              your OK
            </span>
          </p>
        </header>
        {choosing && (
          <p className="queues-choosing" role="status">
            Pick what {name(choosing.owner)} waits for in {name(choosing.choice.agent)}&apos;s lane:
            one of its tasks, or its end for all of its work. Esc keeps all of its work.
          </p>
        )}
        <div className="queues-scroll">
          {lanes.length === 0 && <p className="queues-empty">No agents yet.</p>}
          <div
            ref={grid}
            className="queues-grid"
            data-pointing={active.size > 0 ? '' : undefined}
            style={{
              gridTemplateColumns: lanes.map(() => 'minmax(280px, 1fr)').join(` ${String(GAP)}px `),
              gridTemplateRows: `auto repeat(${String(rows)}, auto) minmax(16px, 1fr)`,
            }}
            onPointerOver={(event) => {
              const on = event.target instanceof Element ? event.target : null;
              setPointed(
                on?.closest('[data-link]')?.getAttribute('data-link') ??
                  on?.closest('[data-at]')?.getAttribute('data-at') ??
                  null,
              );
            }}
            onPointerLeave={() => {
              setPointed(null);
            }}
          >
            {lanes.map((lane, i) => (
              <Fragment key={lane.agent.id}>
                <LaneCells
                  lane={lane}
                  column={2 * i + 1}
                  nodes={nodes}
                  grid={grid}
                  name={name}
                  status={sessions[lane.agent.id]?.status ?? 'idle'}
                  run={run}
                  needsYou={needsYou(lane.agent.id)}
                  ask={asks.find((ask) => ask.agent.id === lane.agent.id)}
                  focused={lane.agent.id === focus}
                  isStuck={isStuck}
                  marks={marks}
                  edits={edits}
                  choosing={choosing}
                  onChoose={(choice) => {
                    setChoosing({ owner: lane.agent.id, choice });
                  }}
                  picking={
                    choosing?.choice.agent === lane.agent.id
                      ? { name: name(lane.agent.id), current: choosingTarget, onPick: pick }
                      : undefined
                  }
                  onOpenAgent={onOpenAgent}
                />
                {i < lanes.length - 1 && (
                  <div
                    className="queues-gap"
                    style={{ gridColumn: 2 * i + 2, gridRow: `2 / span ${String(rows)}` }}
                  >
                    <svg aria-hidden="true">
                      {piecesIn(ribbons, i).map((piece) => {
                        const paths = piecePaths(piece, GAP);
                        return (
                          <g
                            key={piece.key}
                            data-link={piece.key}
                            data-kind={piece.kind}
                            data-mark={piece.stuck ? 'stuck' : piece.kind}
                            data-timed={piece.timed ? '' : undefined}
                            data-active={active.has(piece.key) ? '' : undefined}
                            data-flow={flowing.has(piece.key) ? '' : undefined}
                          >
                            <path className="queues-ribbon" d={paths.fill} />
                            <path className="queues-ribbon-edges" d={paths.edges} />
                            {paths.arrow && (
                              <path className="queues-ribbon-arrow" d={paths.arrow} />
                            )}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * An agent's lane, as grid items: its head, where it waits, its tasks (each the queue's own row,
 * reordered by its handle among the lane's), and its end with a ⊕ to add to it. While a wait's
 * target is picked in it (`picking`), each task and its end are buttons that pick.
 */
function LaneCells({
  lane,
  column,
  nodes,
  grid,
  name,
  status,
  run,
  needsYou,
  ask,
  focused,
  isStuck,
  marks,
  edits,
  choosing,
  onChoose,
  picking,
  onOpenAgent,
}: {
  lane: Lane;
  column: number;
  nodes: readonly GraphNode[];
  grid: RefObject<HTMLDivElement | null>;
  name: (id: string) => string;
  /** Its session's status. */
  status: Session['status'];
  run: Run;
  /** The run waits on the user: to decide at its hold, to answer its agent, or to switch one. */
  needsYou: Needs | undefined;
  /** What the run holds the agent for, if it does. */
  ask: HeldAsk | undefined;
  focused: boolean;
  isStuck: Lanes['isStuck'];
  marks: (lane: string, item: string | null) => RowMarks;
  edits: QueueEdits;
  choosing: Choosing | undefined;
  onChoose: (choice: StepChoice) => void;
  picking: Picking | undefined;
  onOpenAgent: (agentId: string) => void;
}) {
  const { agent: node } = lane;
  const id = node.id;
  const agent = node.data.agent ?? DEFAULT_AGENT;
  const connection = connectionOf(node.data);
  const items = lane.cells.map((cell) => cell.item);
  const { dragging, handle } = useSortable(
    items,
    (itemId, index) => {
      edits.move(id, itemId, index);
    },
    () =>
      [...(grid.current?.querySelectorAll<HTMLElement>('.queues-cell') ?? [])].filter(
        (cell) => cell.dataset.lane === id,
      ),
  );
  const agentRun = run.agents[id];
  /** Where the agent has nothing to do until what it waits for is done. */
  const idle = lane.cells.flatMap(({ row }, n) => {
    const previous = lane.cells[n - 1];
    const after = previous ? previous.row + previous.span : 0;
    const before = lane.cells[n];
    const held =
      run.running && agentRun?.status === 'waiting' && agentRun.current === before?.item.id;
    return row > after ? [{ from: after, to: row, held }] : [];
  });
  const edit = {
    node,
    nodes,
    agent,
    actions: AGENT_ACTIONS[agent],
    ...editsOf(edits, id),
    onChooseStep: onChoose,
    marks: (itemId: string | null) => marks(id, itemId),
  };
  /** The item the run holds the agent at, if any. */
  const held =
    agentRun?.current === undefined
      ? undefined
      : findItem(node.data.queue ?? [], agentRun.current)?.item;
  return (
    <>
      <div
        className="queues-lane"
        style={{ gridColumn: column, gridRow: '1 / -1' }}
        data-focus={focused ? '' : undefined}
        data-picking={picking ? '' : undefined}
      />
      <div
        className="queues-head"
        data-lane={id}
        data-agent={agent}
        data-status={status}
        data-run={
          needsYou
            ? 'asking'
            : agentRun &&
                (run.running || agentRun.status === 'done' || agentRun.status === 'stopped')
              ? agentRun.status
              : undefined
        }
        style={{ gridColumn: column, gridRow: 1 }}
      >
        <span className="queues-status" aria-hidden="true" />
        <button
          type="button"
          aria-label={`Open ${name(id)}`}
          onClick={() => {
            onOpenAgent(id);
          }}
        >
          {name(id)}
        </button>
        {connection !== 'simulated' && (
          <span className="queues-connection" title={CONNECTION_INFO[connection].description}>
            {CONNECTION_INFO[connection].short}
          </span>
        )}
        {needsYou === 'switch' && ask?.refusal && (
          <div className="queues-refused" role="group" aria-label={`${name(id)} needs you`}>
            <p title={ask.text}>{ask.text}</p>
            {ask.choices.map((choice) => (
              <button
                key={choice.key}
                type="button"
                data-primary={choice.primary ? '' : undefined}
                onClick={() => {
                  edits.decide(id, ask.item.id, { choice: choice.key });
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}
        {needsYou !== undefined && needsYou !== 'switch' && (
          <button
            type="button"
            className="queues-needs"
            aria-label={needsYou === 'decide' ? `Decide for ${name(id)}` : `Answer ${name(id)}`}
            title={
              needsYou === 'answer'
                ? `${name(id)} asks permission: open it to answer`
                : agentRun?.usage
                  ? `${name(id)}: ${holdText(agentRun.usage)}`
                  : held && isRepeat(held)
                    ? `${name(id)}'s repeat is out of rounds`
                    : `${name(id)} waits for your OK`
            }
            onClick={() => {
              if (needsYou === 'answer') {
                onOpenAgent(id);
                return;
              }
              // The held row, brought into view, with its decision bar's first button focused.
              const held = [
                ...(grid.current?.querySelectorAll<HTMLElement>('[data-at]') ?? []),
              ].find((row) => row.dataset.at === at(id, agentRun?.current ?? null));
              held?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              held?.querySelector<HTMLElement>('.graph-queue-decide button')?.focus();
            }}
          >
            Needs you
          </button>
        )}
      </div>
      {idle.map(({ from, to, held }) => (
        <div
          key={`idle-${String(from)}`}
          className="queues-idle"
          title={`${name(id)} waits`}
          data-held={held ? '' : undefined}
          style={{ gridColumn: column, gridRow: `${String(from + 2)} / ${String(to + 2)}` }}
        />
      ))}
      {lane.cells.map(({ item, row, span, inner }, index) => (
        <div
          key={item.id}
          className={item.id === dragging ? 'queues-cell dragging' : 'queues-cell'}
          role="group"
          aria-label={`${name(id)}: ${taskLabel(nodes, item)}${isStuck(id, item.id) ? ' (stuck)' : ''}`}
          data-lane={id}
          // A repeat's cell is a subgrid of the rows it spans: each item it holds in its own.
          data-repeat={inner ? '' : undefined}
          style={{ gridColumn: column, gridRow: `${String(row + 2)} / span ${String(span)}` }}
        >
          <QueueRow
            item={item}
            handle={handle(item, index)}
            {...edit}
            {...(choosing?.owner === id
              ? { choosing: { waitId: choosing.choice.waitId, index: choosing.choice.index } }
              : {})}
            {...(inner
              ? {
                  rowOf: (itemId: string) => {
                    const cell = inner.find((c) => c.item.id === itemId);
                    return cell && cell.row - row;
                  },
                  // Each item in a repeat picks, and its header the repeat.
                  picking,
                }
              : {})}
          />
          {picking && !inner && (
            <PickTask
              label={`Wait for ${picking.name}: ${itemLabel(item)}`}
              pressed={picking.current === item.id}
              onPick={() => {
                picking.onPick(item.id);
              }}
            />
          )}
        </div>
      ))}
      <div className="queues-end-cell" style={{ gridColumn: column, gridRow: lane.end + 2 }}>
        <QueueEnd
          marks={marks(id, null)}
          pick={
            picking && {
              label: `Wait for all of ${picking.name}'s work`,
              pressed: picking.current === undefined,
              onPick: () => {
                picking.onPick(undefined);
              },
            }
          }
        />
        <QueueAddMenu
          node={node}
          nodes={nodes}
          actions={AGENT_ACTIONS[agent]}
          label={`Add to ${name(id)}'s queue`}
          up={false}
          onAdd={(entry) => {
            edits.add(id, entry);
          }}
          onChooseStep={onChoose}
        />
      </div>
    </>
  );
}

/** The tasks a link joins (work handed on joins a lane, not a task, at its other end). */
function ends(link: Link): string[] {
  return [
    at(link.from.lane, link.from.item),
    ...(link.kind === 'wait' ? [at(link.to.lane, link.to.item)] : []),
  ];
}

/** The waits a run is held at, by their links to what is not yet done: their ribbons flow. */
function flowingWaits({ links }: Lanes, run: Run): Set<string> {
  if (!run.running) return new Set();
  return new Set(
    links.flatMap((link) => {
      if (link.kind !== 'wait') return [];
      const waiting = run.agents[link.to.lane];
      if (waiting?.status !== 'waiting' || waiting.current !== link.to.item) return [];
      const target = run.agents[link.from.lane];
      const done =
        link.from.item === null
          ? target?.status === 'done'
          : target?.outcomes[link.from.item] !== undefined;
      return done ? [] : [link.key];
    }),
  );
}
