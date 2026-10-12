import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { threadTitle } from '../agent/session';
import type { Session } from '../agent/session';
import { DEFAULT_AGENT } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { ifText, itemLabel } from '../graph/labels';
import { isIf, isMessage, isWait } from '../graph/queue';
import type { QueueItem, QueueMessage, QueueStep } from '../graph/queue';
import { lanesOf } from './lanes';
import type { Link } from './lanes';
import { LINE, piecePaths, piecesIn, ribbonsOf, rowTops } from './ribbons';
import './QueuesView.css';

/** How wide the gap between two lanes is, where ribbons join their lines. */
const GAP = 64;

/**
 * Every agent's queue side by side, read like a diff viewer: each lane a pane of numbered lines (an
 * item each, an if-then a line per step), its rows aligned with the other lanes' so order reads
 * downwards (lanes.ts): a wait sits below what it waits for, with hatching where its agent waits.
 * Ribbons in the gaps join the lines that link lanes (ribbons.ts): a wait to what it waits for, and
 * a step handed to another agent, narrowing into that agent's lane; waits in a loop are stuck.
 * Opened from the canvas, or from an agent (`focus`, whose lane is brought into view). Escape, Back
 * or a click outside closes it; an agent's name opens that agent.
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
  const ribbons = useMemo(() => ribbonsOf(layout), [layout]);
  const { lanes, heights, links, isStuck } = layout;
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

  /** What links mark: the lines handed to another agent, and what waits wait for. */
  const at = (lane: string, item: string | null) => JSON.stringify([lane, item]);
  const handed = new Set(
    links.flatMap((l) => (l.kind === 'handoff' ? [at(l.from.lane, l.from.item)] : [])),
  );
  const waitedFor = new Set(
    links.flatMap((l) => (l.kind === 'wait' ? [at(l.from.lane, l.from.item)] : [])),
  );

  /** What the pointer is on, a ribbon (its key) or a line (`at`): its links show over the rest. */
  const [pointed, setPointed] = useState<string | null>(null);
  const ends = (l: Link) => [
    at(l.from.lane, l.from.item),
    ...(l.kind === 'wait' ? [at(l.to.lane, l.to.item)] : []),
  ];
  const shown = links.filter((l) => l.key === pointed || ends(l).includes(pointed ?? ''));
  const active = new Set(shown.map((l) => l.key));
  const activeEnds = new Set(shown.flatMap(ends));

  /** How a step or a message reads in a lane, with the agent it is aimed at if another. */
  const aimed = (step: QueueStep | QueueMessage) => {
    const what = isMessage(step)
      ? `Message ${step.message.trim() === '' ? '(empty)' : `“${threadTitle(step.message, 48)}”`}`
      : step.action;
    return step.target === undefined ? what : `${what} → ${name(step.target)}`;
  };
  const describe = (item: QueueItem): string => {
    if (isWait(item)) {
      const targets = item.waitFor.map(({ agent, item: step }) => {
        if (step === undefined) return name(agent);
        const found = nodes.find((n) => n.id === agent)?.data.queue?.find((q) => q.id === step);
        return `${name(agent)}: ${found ? itemLabel(found) : 'a removed step'}`;
      });
      return `Wait for ${targets.join(' and ')}`;
    }
    if (isIf(item)) return `If ${ifText(item.if)}`;
    return aimed(item);
  };

  const tops = rowTops(heights);
  const rows = heights.map((lines) => `${String(lines * LINE)}px`).join(' ');
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
            style={{
              gridTemplateColumns: lanes.map(() => 'minmax(240px, 1fr)').join(` ${String(GAP)}px `),
              gridTemplateRows: `auto ${rows} minmax(${String(LINE)}px, 1fr)`,
            }}
          >
            <div className="queues-heads" style={{ gridColumn: '1 / -1', gridRow: 1 }} />
            {lanes.map((lane, i) => {
              const id = lane.agent.id;
              const column = 2 * i + 1;
              const status = sessions[id]?.status ?? 'idle';
              /** Where the agent has nothing to do until what it waits for is done. */
              const idle = lane.cells.flatMap(({ row }, n) => {
                const after = n === 0 ? 0 : (lane.cells[n - 1]?.row ?? 0) + 1;
                return row > after ? [{ from: after, to: row }] : [];
              });
              const pieces = i < lanes.length - 1 ? piecesIn(ribbons, i) : [];
              return (
                <Fragment key={id}>
                  <div
                    className="queues-pane"
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
                      title="Waiting"
                      style={{
                        gridColumn: column,
                        gridRow: `${String(from + 2)} / ${String(to + 2)}`,
                      }}
                    />
                  ))}
                  {lane.cells.map(({ item, row }, n) => {
                    const stuck = isStuck(id, item.id);
                    const text = describe(item);
                    const mark = isWait(item)
                      ? stuck
                        ? 'stuck'
                        : 'wait'
                      : handed.has(at(id, item.id))
                        ? 'handoff'
                        : undefined;
                    return (
                      <div
                        key={item.id}
                        className="queues-item"
                        role="group"
                        aria-label={`${name(id)}: ${text}${stuck ? ' (stuck)' : ''}`}
                        data-waited-for={waitedFor.has(at(id, item.id)) ? '' : undefined}
                        data-at={at(id, item.id)}
                        data-active={activeEnds.has(at(id, item.id)) ? '' : undefined}
                        style={{ gridColumn: column, gridRow: row + 2 }}
                      >
                        <Line number={n + 1} text={text} mark={mark} />
                        {isIf(item) &&
                          item.then.map((step) => (
                            <Line
                              key={step.id}
                              nested
                              at={at(id, step.id)}
                              active={activeEnds.has(at(id, step.id))}
                              text={aimed(step)}
                              mark={handed.has(at(id, step.id)) ? 'handoff' : undefined}
                            />
                          ))}
                      </div>
                    );
                  })}
                  <div
                    className="queues-item queues-end"
                    data-end
                    data-waited-for={waitedFor.has(at(id, null)) ? '' : undefined}
                    data-at={at(id, null)}
                    data-active={activeEnds.has(at(id, null)) ? '' : undefined}
                    style={{ gridColumn: column, gridRow: lane.end + 2 }}
                  >
                    <Line text="End" />
                  </div>
                  {pieces.length > 0 && (
                    <svg
                      className="queues-ribbons"
                      aria-hidden="true"
                      width={GAP}
                      height={tops.at(-1)}
                      style={{
                        gridColumn: column + 1,
                        gridRow: `2 / span ${String(heights.length)}`,
                      }}
                    >
                      {pieces.map((piece) => {
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

/** A line of a lane: its number in the queue (if it has one), and what it does. */
function Line({
  number,
  nested = false,
  at,
  active = false,
  text,
  mark,
}: {
  number?: number;
  /** A step of an if-then, under its condition: then it has its own links (`at`). */
  nested?: boolean;
  at?: string;
  /** Whether a link of what the pointer is on ends here. */
  active?: boolean;
  text: string;
  mark?: string | undefined;
}) {
  return (
    <div
      className="queues-line"
      data-mark={mark}
      data-nested={nested ? '' : undefined}
      data-at={at}
      data-active={active ? '' : undefined}
    >
      <span className="queues-number">{number}</span>
      <span className="queues-text" title={text}>
        {text}
      </span>
    </div>
  );
}
