import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { Session } from '../agent/session';
import type { TerminalBackend } from './backend';
import { TerminalLink } from './link';
import type { LinkState } from './link';
import { createScreen } from './screen';
import type { ScreenFactory } from './screen';
import './TerminalPane.css';

/** What the bar under the terminal says the session is doing. */
const STATUS: Record<Session['status'], string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you, in the terminal',
};

/**
 * A Terminal agent's session: Claude Code's own terminal (its CLI runs in the main process, and
 * this shows it: link.ts), in place of the transcript and composer, so that everything Claude Code
 * does works here as it does in a terminal. Under it, a bar with what the queues' run asks of the
 * user (`ask`: their OK, or a repeat out of rounds), the last warning the session gave until it is
 * dismissed (corrallm took an answer to its question as no, or Claude Code did not take a message
 * typed in: what the transcript would show), what the session is doing (as corrallm follows it),
 * the messages queued for it (corrallm types each into the terminal once Claude Code is ready),
 * and the queue's ⊕. Over it, while no CLI runs: why, and a button to start it again (resuming its
 * session).
 */
export function TerminalPane({
  agentId,
  backend,
  session,
  note,
  ask,
  above,
  onStart,
  onUnqueue,
  screens = createScreen,
}: {
  agentId: string;
  backend: TerminalBackend;
  session: Session;
  /** How the session runs, and where (or what it needs to). */
  note: string;
  /** What the queues' run asks of the user, if anything: first in the bar, with its answers. */
  ask?: ReactNode;
  /** What sits in the bar (the queue's ⊕). */
  above?: ReactNode;
  /** Starts its CLI again, resuming its session. */
  onStart: () => void;
  /** Takes a queued message off the queue. */
  onUnqueue: (queuedId: string) => void;
  /** Makes the terminal (xterm.js; a fake in tests). */
  screens?: ScreenFactory;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LinkState>({ kind: 'waiting' });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setState({ kind: 'waiting' });
    const screen = screens(element);
    const link = new TerminalLink(agentId, backend, screen, (next) => {
      setState(next);
      if (next.kind === 'live') screen.focus();
    });
    link.start();
    const observer = new ResizeObserver(() => {
      screen.fit();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      link.stop();
      screen.dispose();
    };
  }, [agentId, backend, screens]);

  /** Why the CLI does not run: the last thing that went wrong, if anything did. */
  const problem = session.entries.findLast(
    (entry) => entry.kind === 'notice' && entry.level === 'error',
  );
  const warning = session.entries.findLast(
    (entry) => entry.kind === 'notice' && entry.level === 'warning',
  );
  /** The warning the user dismissed, by id. */
  const [dismissed, setDismissed] = useState<string>();
  return (
    <section className="agent-session agent-terminal-session" aria-label="Session">
      <div className="agent-terminal" data-state={state.kind}>
        <div ref={host} className="agent-terminal-screen" aria-label="Claude Code’s terminal" />
        {state.kind !== 'live' && (
          <div className="agent-terminal-overlay" role="status">
            {state.kind === 'exited' ? (
              <>
                <p>
                  Claude Code exited
                  {state.code !== null && state.code !== 0 ? ` (code ${String(state.code)})` : ''}.
                </p>
                <button type="button" onClick={onStart}>
                  Start it again
                </button>
              </>
            ) : problem?.kind === 'notice' ? (
              <>
                <p>Claude Code isn’t running.</p>
                <p className="agent-terminal-why">{problem.text}</p>
                <button type="button" onClick={onStart}>
                  Try again
                </button>
              </>
            ) : (
              <p>Starting Claude Code…</p>
            )}
          </div>
        )}
      </div>
      <div className="agent-terminal-bar">
        {ask}
        {warning?.kind === 'notice' && warning.id !== dismissed && (
          <p className="agent-terminal-warning" role="note">
            {warning.text}
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => {
                setDismissed(warning.id);
              }}
            />
          </p>
        )}
        {session.queued.length > 0 && (
          <ul className="agent-queued" aria-label="Queued messages">
            {session.queued.map((queued) => (
              <li key={queued.id}>
                {queued.text}
                <button
                  type="button"
                  aria-label={`Take back queued message: ${queued.text}`}
                  title="Take it off the queue"
                  onClick={() => {
                    onUnqueue(queued.id);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="agent-terminal-row">
          {above}
          <span className="agent-terminal-status" data-status={session.status} role="status">
            {STATUS[session.status]}
          </span>
          <span className="agent-terminal-note">{note}</span>
        </div>
      </div>
    </section>
  );
}
