import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { threadTitle } from '../agent/session';
import type { Session } from '../agent/session';
import { DEFAULT_AGENT } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { ifText, itemLabel } from '../graph/labels';
import { isIf, isMessage, isWait } from '../graph/queue';
import type { QueueItem, QueueMessage, QueueStep, WaitTarget } from '../graph/queue';
import { lanesOf } from './lanes';
import type { Link } from './lanes';
import { piecePaths, piecesIn, ribbonsOf } from './ribbons';
import type { Span } from './ribbons';
import './QueuesView.css';

/** How wide the gap between two lanes is, where ribbons join their tasks. */
const GAP = 64;

/**
 * Every agent's queue side by side, task by task, laid out like a diff viewer: each lane a pane of
 * its tasks, in rows aligned with the other lanes' so order reads downwards (lanes.ts). Where a
 * task sits in front of a task in another lane (a wait, after what it waits for), or hands work
 * to another agent, a ribbon in the gap between the lanes joins them (ribbons.ts), as a diff
 * viewer joins the blocks that differ; hatching shows where an agent waits, and waits in a loop
 * are stuck. Pointing at a task or a ribbon shows its links over the rest. Opened from the canvas,
 * or from an agent (`focus`, whose lane is brought into view). Escape, Back or a click outside
 * closes it; an agent's name opens that agent.
 */
export function QueuesView({
  nodes,
  sessions,
  focus,
  backLabel,
  onOpenAgent,
  onClose,
}: {
  nodes: readonly GraphNode[];
  sessions: Readonly<Record<string, Session>>;
  focus?: string;
  /** Where Back goes: "Canvas", or the agent it was opened from. */
  backLabel: string;
  onOpenAgent: (agentId: string) => void;
  onClose: () => void;
}) {
  const layout = useMemo(() => lanesOf(nodes), [nodes]);
  const { lanes, rows, links, isStuck } = layout;
  const grid = useRef<HTMLDivElement>(null);
  const name = (id: string) =>
    (nodes.find((n) => n.id === id)?.data.label ?? '') || 'Unnamed agent';

  // Escape closes this, before whatever is under it hears it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);
  useEffect(() => {
    if (focus === undefined) return;
    [...(grid.current?.querySelectorAll<HTMLElement>('[data-lane]') ?? [])]
      .find((lane) => lane.dataset.lane === focus)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [focus]);

  // Where each task is (by `at`), down from the top of the rows: measured after every render, as
  // tasks change, and as the view resizes (text wraps anew); only a change re-renders.
  const at = (lane: string, item: string | null) => JSON.stringify([lane, item]);
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

  /** What links mark: the tasks handed to another agent, and the tasks waits wait for. */
  const handed = new Set(
    links.flatMap((l) => (l.kind === 'handoff' ? [at(l.from.lane, l.from.item)] : [])),
  );
  const waitedFor = new Set(
    links.flatMap((l) => (l.kind === 'wait' ? [at(l.from.lane, l.from.item)] : [])),
  );

  /** What the pointer is on, a ribbon (its key) or a task (`at`): its links show over the rest. */
  const [pointed, setPointed] = useState<string | null>(null);
  const ends = (l: Link) => [
    at(l.from.lane, l.from.item),
    ...(l.kind === 'wait' ? [at(l.to.lane, l.to.item)] : []),
  ];
  const shown = links.filter((l) => l.key === pointed || ends(l).includes(pointed ?? ''));
  const active = new Set(shown.map((l) => l.key));
  const activeEnds = new Set(shown.flatMap(ends));
  /** The marks every task carries: where it is measured, and what links it. */
  const marks = (lane: string, item: string | null) => ({
    'data-at': at(lane, item),
    'data-waited-for': waitedFor.has(at(lane, item)) ? '' : undefined,
    'data-active': activeEnds.has(at(lane, item)) ? '' : undefined,
  });

  /** What a wait waits for, in words: an agent (all its work), or one of its tasks. */
  const waitedLabel = ({ agent, item: step }: WaitTarget) => {
    if (step === undefined) return name(agent);
    const found = nodes.find((n) => n.id === agent)?.data.queue?.find((q) => q.id === step);
    return `${name(agent)}: ${found ? itemLabel(found) : 'a removed step'}`;
  };
  /** How a step or a message reads, with the agent it is aimed at if another. */
  const aimed = (step: QueueStep | QueueMessage) => {
    const what = isMessage(step)
      ? `Message ${step.message.trim() === '' ? '(empty)' : `“${threadTitle(step.message, 32)}”`}`
      : step.action;
    return step.target === undefined ? what : `${what} → ${name(step.target)}`;
  };
  const describe = (item: QueueItem): string =>
    isWait(item)
      ? `Wait for ${item.waitFor.map(waitedLabel).join(' and ')}`
      : isIf(item)
        ? `If ${ifText(item.if)}`
        : aimed(item);

  /** A step or a message as a card, in the queue's own words. */
  const stepCard = (lane: string, step: QueueStep | QueueMessage, nested: boolean) => (
    <div
      key={step.id}
      className={nested ? 'queues-task nested' : 'queues-task'}
      data-mark={handed.has(at(lane, step.id)) ? 'handoff' : undefined}
      {...marks(lane, step.id)}
    >
      <div className="queues-task-head">
        {isMessage(step) ? (
          <span className="queues-keyword">Message</span>
        ) : (
          <span className="queues-action">{step.action}</span>
        )}
        {step.target !== undefined && step.target !== lane && (
          <span className="queues-chip">→ {name(step.target)}</span>
        )}
      </div>
      {isMessage(step) && (
        <p className="queues-message">{step.message.trim() === '' ? '(empty)' : step.message}</p>
      )}
    </div>
  );

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
        <div className="queues-scroll">
          {lanes.length === 0 && <p className="queues-empty">No agents yet.</p>}
          <div
            ref={grid}
            className="queues-grid"
            data-pointing={active.size > 0 ? '' : undefined}
            style={{
              gridTemplateColumns: lanes.map(() => 'minmax(260px, 1fr)').join(` ${String(GAP)}px `),
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
            {lanes.map((lane, i) => {
              const id = lane.agent.id;
              const column = 2 * i + 1;
              const status = sessions[id]?.status ?? 'idle';
              /** Where the agent has nothing to do until what it waits for is done. */
              const idle = lane.cells.flatMap(({ row }, n) => {
                const after = n === 0 ? 0 : (lane.cells[n - 1]?.row ?? 0) + 1;
                return row > after ? [{ from: after, to: row }] : [];
              });
              return (
                <Fragment key={id}>
                  <div
                    className="queues-lane"
                    style={{ gridColumn: column, gridRow: '1 / -1' }}
                    data-focus={id === focus ? '' : undefined}
                  />
                  <div
                    className="queues-head"
                    data-lane={id}
                    data-agent={lane.agent.data.agent ?? DEFAULT_AGENT}
                    data-status={status}
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
                  </div>
                  {idle.map(({ from, to }) => (
                    <div
                      key={`idle-${String(from)}`}
                      className="queues-idle"
                      title={`${name(id)} waits`}
                      style={{
                        gridColumn: column,
                        gridRow: `${String(from + 2)} / ${String(to + 2)}`,
                      }}
                    />
                  ))}
                  {lane.cells.map(({ item, row }) => {
                    const stuck = isStuck(id, item.id);
                    const label = `${name(id)}: ${describe(item)}${stuck ? ' (stuck)' : ''}`;
                    const place = { gridColumn: column, gridRow: row + 2 };
                    if (isIf(item))
                      return (
                        <div
                          key={item.id}
                          className="queues-if"
                          role="group"
                          aria-label={label}
                          style={place}
                          {...marks(id, item.id)}
                        >
                          <div className="queues-task-head">
                            <span className="queues-keyword">If</span>
                            <span className="queues-chip">{ifText(item.if)}</span>
                            <span className="queues-keyword">then</span>
                          </div>
                          {item.then.map((step) => stepCard(id, step, true))}
                        </div>
                      );
                    if (isWait(item))
                      return (
                        <div
                          key={item.id}
                          className="queues-task"
                          role="group"
                          aria-label={label}
                          data-mark={stuck ? 'stuck' : 'wait'}
                          style={place}
                          {...marks(id, item.id)}
                        >
                          <div className="queues-task-head">
                            <span className="queues-keyword">Wait for</span>
                            {item.waitFor.map((target) => (
                              <span key={JSON.stringify(target)} className="queues-chip">
                                {waitedLabel(target)}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    return (
                      <div
                        key={item.id}
                        className="queues-cell"
                        role="group"
                        aria-label={label}
                        style={place}
                      >
                        {stepCard(id, item, false)}
                      </div>
                    );
                  })}
                  <div
                    className="queues-end"
                    data-end
                    style={{ gridColumn: column, gridRow: lane.end + 2 }}
                    {...marks(id, null)}
                  >
                    End
                  </div>
                  {i < lanes.length - 1 && (
                    <div
                      className="queues-gap"
                      style={{ gridColumn: column + 1, gridRow: `2 / span ${String(rows)}` }}
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
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
