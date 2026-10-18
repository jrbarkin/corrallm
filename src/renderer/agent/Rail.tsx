import { useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { AgentType } from '../graph/agents';
import type { Session } from './session';

/** An agent waiting in the rail's stack: what its card shows. */
export interface StackedAgent {
  id: string;
  name: string;
  agent: AgentType;
  status: Session['status'];
}

/** How a new agent relates to the one it is spawned from (graph.ts `spawnAgent`). */
export type Relation = 'peer' | 'linked';

/**
 * The agent view's rail, at its right edge: ⊕ spawns a new agent, stacked on the one shown (its ▾
 * offers one linked to it instead), and under it the stack, a card for each other agent opened this
 * way, most recent first, that switches to it. The ⊕ and a card each say where they are on screen,
 * for the agent to grow out of.
 */
export function Rail({
  element,
  name,
  stack,
  onNew,
  onSwitch,
}: {
  /** The rail itself, where the view finds the cards. */
  element: RefObject<HTMLElement | null>;
  /** The name of the agent shown. */
  name: string;
  stack: readonly StackedAgent[];
  onNew: (relation: Relation, from: DOMRect) => void;
  onSwitch: (id: string, from: DOMRect) => void;
}) {
  const plus = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const spawn = (relation: Relation) => {
    setMenu(false);
    const from = plus.current?.getBoundingClientRect();
    if (from) onNew(relation, from);
  };
  return (
    <nav ref={element} className="agent-rail" aria-label="Agents">
      <div
        className="agent-rail-new"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false);
        }}
        onKeyDown={(event) => {
          // Esc closes the menu, not the view.
          if (menu && event.key === 'Escape') {
            event.stopPropagation();
            setMenu(false);
          }
        }}
      >
        <button
          ref={plus}
          type="button"
          className="agent-rail-plus"
          aria-label="New agent"
          title="New agent, stacked on this one"
          onClick={() => {
            spawn('peer');
          }}
        />
        <button
          type="button"
          className="agent-rail-more"
          aria-label="Ways to add an agent"
          aria-haspopup="menu"
          aria-expanded={menu}
          title="New agent: on its own, or linked to this one"
          onClick={() => {
            setMenu(!menu);
          }}
        />
        {menu && (
          <div className="agent-choice-menu" role="menu" aria-label="New agent">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                spawn('peer');
              }}
            >
              New agent
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                spawn('linked');
              }}
            >
              New agent, linked to {name}
            </button>
          </div>
        )}
      </div>
      <ol className="agent-stack" aria-label="Stacked agents">
        {stack.map((stacked) => (
          <li key={stacked.id}>
            <button
              type="button"
              className="agent-stack-card"
              data-stack={stacked.id}
              data-agent={stacked.agent}
              data-status={stacked.status}
              aria-label={`Switch to ${stacked.name}`}
              title={stacked.name}
              onClick={(event) => {
                onSwitch(stacked.id, event.currentTarget.getBoundingClientRect());
              }}
            >
              <span className="agent-stack-name">{stacked.name}</span>
              <span className="agent-stack-status" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
