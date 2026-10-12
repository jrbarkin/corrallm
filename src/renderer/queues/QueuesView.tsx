import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { threadTitle } from '../agent/session';
import type { Session } from '../agent/session';
import { AGENT_ACTIONS, DEFAULT_AGENT } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { ifText, itemLabel } from '../graph/labels';
import { chooseTarget, isIf, isWait } from '../graph/queue';
import type { QueueItem, WaitTarget } from '../graph/queue';
import { QueueAddMenu, QueueRow } from '../graph/QueueEditor';
import type { RowMarks, StepChoice } from '../graph/QueueEditor';
import { useSortable } from '../graph/sortable';
import type { QueueEdits } from '../graph/WorkDetail';
import { taskState } from '../run/runner';
import type { Run } from '../run/runner';
import { lanesOf } from './lanes';
import type { Lane, Lanes, Link } from './lanes';
import { piecePaths, piecesIn, ribbonsOf } from './ribbons';
import type { Span } from './ribbons';
import '../run/run.css';
import './QueuesView.css';

/** How wide the gap between two lanes is, where ribbons join their tasks. */
const GAP = 64;

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
 * Each lane is its agent's queue, edited in place as in the agent's own view (QueueEditor.tsx):
 * a wait's step is picked by clicking it in its agent's lane. Run plays every queue (run/runner.ts):
 * the task each agent is on pulses, a wait it is held at breathes, and what it has done is ticked.
 *
 * Opened from the canvas, or from an agent (`focus`, whose lane is brought into view). Escape, Back
 * or a click outside closes it; an agent's name opens that agent.
 */
export function QueuesView({
  nodes,
  sessions,
  run,
  edits,
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
      if (event.target instanceof Element && event.target.closest('.search-picker')) return;
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
  const marks = markings(layout, run, asking, activeEnds);
  /** Sets the target being picked to a step of its agent, or (undefined) all of its work. */
  const pick = (item: string | undefined) => {
    if (!choosing) return;
    const { owner, choice } = choosing;
    setChoosing(undefined);
    const wait = nodes.find((n) => n.id === owner)?.data.queue?.find((q) => q.id === choice.waitId);
    if (!wait || !isWait(wait)) return;
    const target: WaitTarget =
      item === undefined ? { agent: choice.agent } : { agent: choice.agent, item };
    edits.setWaitFor(owner, wait.id, chooseTarget(wait.waitFor, choice.index, target));
  };

  /** Whether the run waits on the user for an agent: it is on a task, and asks permission. */
  const needsYou = (id: string) =>
    run.running && run.agents[id]?.status === 'running' && asking.has(id);
  const agents = Object.entries(run.agents);
  const count = (which: (id: string, status: string) => boolean) =>
    agents.filter(([id, a]) => which(id, a.status)).length;
  const needed = count((id) => needsYou(id));
  const runStatus = run.running
    ? [
        `${String(count((id, status) => status === 'running' && !needsYou(id)))} working`,
        `${String(count((_, status) => status === 'waiting'))} waiting`,
        ...(needed > 0 ? [`${String(needed)} need${needed === 1 ? 's' : ''} you`] : []),
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
                  focused={lane.agent.id === focus}
                  isStuck={isStuck}
                  marks={marks}
                  edits={edits}
                  choosing={choosing}
                  onChoose={(choice) => {
                    setChoosing({ owner: lane.agent.id, choice });
                  }}
                  picking={choosing?.choice.agent === lane.agent.id ? pick : undefined}
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
  /** The run waits on the user: the agent asks permission. */
  needsYou: boolean;
  focused: boolean;
  isStuck: Lanes['isStuck'];
  marks: (lane: string, item: string | null) => RowMarks;
  edits: QueueEdits;
  choosing: Choosing | undefined;
  onChoose: (choice: StepChoice) => void;
  picking: ((item: string | undefined) => void) | undefined;
  onOpenAgent: (agentId: string) => void;
}) {
  const { agent: node } = lane;
  const id = node.id;
  const agent = node.data.agent ?? DEFAULT_AGENT;
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
    const after = n === 0 ? 0 : (lane.cells[n - 1]?.row ?? 0) + 1;
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
    onAdd: (entry: Parameters<QueueEdits['add']>[1], into?: string) => {
      edits.add(id, entry, into);
    },
    onRemove: (itemId: string) => {
      edits.remove(id, itemId);
    },
    onMove: (itemId: string, index: number) => {
      edits.move(id, itemId, index);
    },
    onRetarget: (itemId: string, target: string | undefined) => {
      edits.retarget(id, itemId, target);
    },
    onEditMessage: (itemId: string, message: string) => {
      edits.editMessage(id, itemId, message);
    },
    onCondition: (ifId: string, condition: Parameters<QueueEdits['setCondition']>[2]) => {
      edits.setCondition(id, ifId, condition);
    },
    onWaitFor: (waitId: string, targets: WaitTarget[]) => {
      edits.setWaitFor(id, waitId, targets);
    },
    onChooseStep: onChoose,
    marks: (itemId: string) => marks(id, itemId),
  };
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
            : agentRun && (run.running || agentRun.status === 'done')
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
        {needsYou && (
          <button
            type="button"
            className="queues-needs"
            aria-label={`Answer ${name(id)}`}
            title={`${name(id)} asks permission: open it to answer`}
            onClick={() => {
              onOpenAgent(id);
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
      {lane.cells.map(({ item, row }, index) => (
        <div
          key={item.id}
          className={item.id === dragging ? 'queues-cell dragging' : 'queues-cell'}
          role="group"
          aria-label={`${name(id)}: ${describe(item, nodes, name)}${isStuck(id, item.id) ? ' (stuck)' : ''}`}
          data-lane={id}
          style={{ gridColumn: column, gridRow: row + 2 }}
        >
          <QueueRow
            item={item}
            handle={handle(item, index)}
            {...edit}
            {...(choosing?.owner === id
              ? { choosing: { waitId: choosing.choice.waitId, index: choosing.choice.index } }
              : {})}
          />
          {picking && (
            <button
              type="button"
              className="queues-pick"
              aria-label={`Wait for ${name(id)}: ${itemLabel(item)}`}
              onClick={() => {
                picking(item.id);
              }}
            />
          )}
        </div>
      ))}
      <div className="queues-end-cell" style={{ gridColumn: column, gridRow: lane.end + 2 }}>
        <div className="queues-end" data-end {...marks(id, null)}>
          End
          {picking && (
            <button
              type="button"
              className="queues-pick"
              aria-label={`Wait for all of ${name(id)}'s work`}
              onClick={() => {
                picking(undefined);
              }}
            />
          )}
        </div>
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

/** A task's key, for its measured span and its links: its agent's lane and its id (null: the end). */
function at(lane: string, item: string | null): string {
  return JSON.stringify([lane, item]);
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

/**
 * Every task's marks, by lane and id (null: the lane's end): `data-at` (where it is measured),
 * `data-mark` (a wait, stuck, or work handed on), `data-waited-for`, `data-active` (a link of what
 * the pointer is on ends there), and `data-run` (the run is on it, held at it, waits on the user
 * for it as its agent (in `asking`) asks permission, or how it went).
 */
function markings(
  { lanes, links, isStuck }: Lanes,
  run: Run,
  asking: ReadonlySet<string>,
  activeEnds: ReadonlySet<string>,
): (lane: string, item: string | null) => RowMarks {
  const handed = new Set(
    links.flatMap((l) => (l.kind === 'handoff' ? [at(l.from.lane, l.from.item)] : [])),
  );
  const waitedFor = new Set(
    links.flatMap((l) => (l.kind === 'wait' ? [at(l.from.lane, l.from.item)] : [])),
  );
  const waits = new Set(
    lanes.flatMap((lane) =>
      lane.cells.flatMap(({ item }) => (isWait(item) ? [at(lane.agent.id, item.id)] : [])),
    ),
  );
  return (lane, item) => {
    const key = at(lane, item);
    const state = taskState(run, lane, item);
    const mark =
      item !== null && waits.has(key)
        ? isStuck(lane, item)
          ? 'stuck'
          : 'wait'
        : handed.has(key)
          ? 'handoff'
          : undefined;
    return {
      'data-at': key,
      'data-mark': mark,
      'data-waited-for': waitedFor.has(key) ? '' : undefined,
      'data-active': activeEnds.has(key) ? '' : undefined,
      'data-run': state === 'running' && asking.has(lane) ? 'asking' : state,
    };
  };
}

/** How an item reads, for its lane's name for it. */
function describe(
  item: QueueItem,
  nodes: readonly GraphNode[],
  name: (id: string) => string,
): string {
  if (isWait(item)) {
    const targets = item.waitFor.map(({ agent, item: step }) => {
      if (step === undefined) return name(agent);
      const found = nodes.find((n) => n.id === agent)?.data.queue?.find((q) => q.id === step);
      return `${name(agent)}: ${found ? itemLabel(found) : 'a removed step'}`;
    });
    return `Wait for ${targets.join(' and ')}`;
  }
  if (isIf(item)) return `If ${ifText(item.if)}`;
  const what =
    'message' in item
      ? `Message ${item.message.trim() === '' ? '(empty)' : `“${threadTitle(item.message, 32)}”`}`
      : item.action;
  return item.target === undefined ? what : `${what} → ${name(item.target)}`;
}
