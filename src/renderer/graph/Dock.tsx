import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { CanvasNode, AgentNode } from '../../shared/model/canvas';
import type { Session } from '../../shared/model/session';
import type { Run } from '../../shared/engine/run/runner';
import { queueControlText } from '../../shared/engine/run/controls';
import { AdapterLogo } from '../AdapterLogo';
import { slide } from '../agent/motion';
import { agentLabel, connectionOf, DEFAULT_AGENT } from './agents';
import './Dock.css';

/** The canvas's agents, grouped as on the canvas; the same buttons become its window taskbar. */
export function Dock({
  nodes,
  sessions,
  run,
  needs,
  current,
  queues,
  onToggleQueues,
  onOpen,
  onStart,
}: {
  nodes: readonly CanvasNode[];
  sessions: Readonly<Record<string, Session>>;
  run: Run;
  needs: ReadonlySet<string>;
  current?: string | undefined;
  queues: boolean;
  onToggleQueues: () => void;
  onOpen: (id: string) => void;
  onStart: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const horizontal = current !== undefined;
  const before = useRef<{ horizontal: boolean; boxes: Map<string, DOMRect> }>(undefined);
  const animations = useRef<Animation[]>([]);
  // The guide's FLIP: keep each button's old screen position, then fly it to the new layout.
  useLayoutEffect(() => {
    const element = root.current;
    const prior = animations.current;
    animations.current = [];
    for (const animation of prior) {
      void animation.finished.catch(() => undefined);
      animation.cancel();
    }
    const elements = [...(root.current?.querySelectorAll<HTMLElement>('[data-dock-id]') ?? [])];
    const previous = before.current;
    before.current = {
      horizontal,
      boxes: new Map(
        elements.map((element) => [element.dataset.dockId ?? '', element.getBoundingClientRect()]),
      ),
    };
    if (previous && previous.horizontal !== horizontal) {
      animations.current = slide(
        elements,
        (element) => element.dataset.dockId,
        previous.boxes,
        420,
      );
      if (animations.current.length > 0 && element) {
        const playing = animations.current;
        element.setAttribute('data-moving', '');
        void Promise.all(playing.map((animation) => animation.finished)).then(
          () => {
            if (animations.current === playing) element.removeAttribute('data-moving');
          },
          () => undefined,
        );
      }
    }
    return () => {
      element?.removeAttribute('data-moving');
    };
  }, [horizontal, nodes]);
  useLayoutEffect(
    () => () => {
      for (const animation of animations.current) {
        void animation.finished.catch(() => undefined);
        animation.cancel();
      }
      animations.current = [];
    },
    [],
  );
  const children = useMemo(() => {
    const ids = new Set(nodes.map((node) => node.id));
    const groups = new Map<string | undefined, CanvasNode[]>();
    for (const node of nodes) {
      const parent = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
      const group = groups.get(parent) ?? [];
      group.push(node);
      groups.set(parent, group);
    }
    return groups;
  }, [nodes]);
  const icon = (node: AgentNode) => {
    const name = node.data.label || 'Unnamed agent';
    const adapter = node.data.adapter ?? DEFAULT_AGENT;
    const state = status(node.id, sessions, run, needs);
    const label = `${name}, ${agentLabel(adapter, connectionOf(node.data))}: ${state}`;
    return (
      <button
        key={node.id}
        type="button"
        className="dock-agent"
        data-dock-id={`agent:${node.id}`}
        aria-label={label}
        title={label}
        aria-current={current === node.id ? 'true' : undefined}
        data-status={state}
        data-needs={needs.has(node.id) ? '' : undefined}
        onClick={() => {
          onOpen(node.id);
        }}
      >
        <span className="dock-logo">
          <AdapterLogo adapter={adapter} size={18} />
        </span>
        <span className="dock-status" aria-hidden="true" />
      </button>
    );
  };
  const group = (node: CanvasNode): ReactNode => {
    const members = children.get(node.id) ?? [];
    if (members.length === 0) return node.type === 'agent' ? icon(node) : null;
    return (
      <div
        key={node.id}
        className="dock-group"
        role="group"
        aria-label={node.data.label || 'Unnamed group'}
      >
        <span className="dock-group-name" aria-hidden="true">
          {node.data.label}
        </span>
        {node.type === 'agent' && icon(node)}
        {members.map(group)}
      </div>
    );
  };
  return (
    <nav
      ref={root}
      className="canvas-dock"
      aria-label="Canvas agents"
      data-horizontal={horizontal ? '' : undefined}
    >
      <button
        type="button"
        className="dock-toggle"
        aria-label="Show all queues"
        aria-pressed={queues}
        title={queues ? 'Back to the graph' : 'All queues: every agent’s, side by side'}
        data-dock-id="queues"
        onClick={onToggleQueues}
      >
        ▥
      </button>
      <div className="dock-agents">{(children.get(undefined) ?? []).map(group)}</div>
      <div className="dock-start" data-dock-id="start">
        <button
          type="button"
          aria-label="Start a session"
          title="Start a session"
          onClick={onStart}
        >
          +
        </button>
      </div>
    </nav>
  );
}

/** The most immediate work first: a live session, then its queue's state. */
function status(
  id: string,
  sessions: Readonly<Record<string, Session>>,
  run: Run,
  needs: ReadonlySet<string>,
): string {
  if (needs.has(id)) return 'Needs you';
  const control = queueControlText(run, id);
  if (control) return control;
  const session = sessions[id]?.status;
  if (session === 'waiting') return 'Needs you';
  if (session === 'working') return 'Working';
  const queued = run.agents[id];
  if (!queued) return 'Idle';
  if (queued.status === 'done') return 'Done';
  if (queued.status === 'stopped') return 'Stopped';
  if (run.paused) return 'Paused';
  return {
    running: 'Working',
    waiting: 'Waiting',
    asking: 'Needs you',
    stopped: 'Stopped',
    done: 'Done',
  }[queued.status];
}
