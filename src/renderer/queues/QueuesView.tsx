import { Fragment, useEffect, useMemo, useRef } from 'react';

import { QueueLinks } from '../agent/QueueLinks';
import { threadTitle } from '../agent/session';
import type { Session } from '../agent/session';
import { DEFAULT_AGENT } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { ifText, itemLabel } from '../graph/labels';
import { isIf, isMessage, isWait } from '../graph/queue';
import type { QueueItem, QueueMessage, QueueStep } from '../graph/queue';
import { lanesOf } from './lanes';
import './QueuesView.css';

/**
 * Every agent's queue, side by side, as lanes (lanes.ts) whose rows read in order downwards: a
 * wait sits below what it waits for. Lines show where queues merge (a wait, from what it waits
 * for) and where they part (work one agent hands another, dashed); items in a loop of waits are
 * marked stuck. Opened from the canvas, or from an agent (`focus`, whose lane is brought into
 * view). Escape, Back or a click outside closes it; an agent's name opens that agent.
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
  const { lanes, rows, links, isStuck } = useMemo(() => lanesOf(nodes), [nodes]);
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

  /** How a step or a message reads in a lane, with the agent it is aimed at if another. */
  const aimed = (step: QueueStep | QueueMessage) => {
    const what = isMessage(step)
      ? `Message ${step.message.trim() === '' ? '(empty)' : `“${threadTitle(step.message, 32)}”`}`
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
            <span className="queues-key wait">waits for</span>
            <span className="queues-key handoff">hands work to</span>
            <span className="queues-key stuck">stuck</span>
          </p>
        </header>
        <div className="queues-scroll">
          {lanes.length === 0 && <p className="queues-empty">No agents yet.</p>}
          <div
            ref={grid}
            className="queues-grid"
            style={{
              gridTemplateColumns: `repeat(${String(lanes.length)}, 240px)`,
              gridTemplateRows: `auto repeat(${String(rows + 1)}, minmax(44px, auto))`,
            }}
          >
            {lanes.map((lane, i) => {
              const id = lane.agent.id;
              const column = i + 1;
              const status = sessions[id]?.status ?? 'idle';
              return (
                <Fragment key={id}>
                  <div
                    className="queues-lane"
                    style={{ gridColumn: column, gridRow: `1 / ${String(rows + 3)}` }}
                    data-focus={id === focus ? '' : undefined}
                  />
                  <div
                    className="queues-head"
                    data-lane={id}
                    data-column={id}
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
                  {lane.cells.map(({ item, row }) => {
                    const stuck = isStuck(id, item.id);
                    const text = describe(item);
                    return (
                      <div
                        key={item.id}
                        className={stuck ? 'queues-cell stuck' : 'queues-cell'}
                        role="group"
                        aria-label={`${name(id)}: ${text}${stuck ? ' (stuck)' : ''}`}
                        data-column={id}
                        data-item={item.id}
                        data-kind={isWait(item) ? 'wait' : isIf(item) ? 'if' : 'step'}
                        style={{ gridColumn: column, gridRow: row + 2 }}
                      >
                        <span className="queues-cell-text">{text}</span>
                        {isIf(item) && item.then.length > 0 && (
                          <ul>
                            {item.then.map((step) => (
                              <li key={step.id}>{aimed(step)}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  <p
                    className="queues-end"
                    data-column={id}
                    data-end
                    style={{ gridColumn: column, gridRow: lane.end + 2 }}
                  >
                    End
                  </p>
                </Fragment>
              );
            })}
            <QueueLinks container={grid} links={links} />
          </div>
        </div>
      </div>
    </div>
  );
}
