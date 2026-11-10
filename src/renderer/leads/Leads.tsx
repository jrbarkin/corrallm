import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

import type { LeadGrants, LeadView } from '../../shared/api/ops/leads';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import { api } from '../api/client';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';

/*
 * Who leads (B24 X2, X3): read from the `leads:<c>` topic alone, changed by `agent.setLead` and
 * `outside.setGrant`, one operation per gesture. Both are yours alone; the core refuses every token.
 */

const NONE: LeadGrants = { questions: false, plans: false, approvals: false };
const GRANTS = [
  ['questions', 'Answers questions'],
  ['plans', 'Answers plans'],
  ['approvals', 'Answers approvals'],
] as const;
const HELD_WORDS = {
  role: 'its role changed',
  adapter: 'its CLI changed',
  connection: 'its connection changed',
} as const;

/** The lead `agent` is on this canvas, if you made it one. */
function leadOf(
  state: { leads: readonly LeadView[] } | undefined,
  agent: string,
): LeadView | undefined {
  return state?.leads.find((lead) => lead.agent === agent);
}

/** Which canvas the graph shows, for the cards' marks: provided by the graph, never by a card. */
const Context = createContext<{ canvas: CanvasId; mirror?: TopicMirror | undefined } | null>(null);

export function LeadsProvider({
  canvas,
  mirror,
  children,
}: {
  canvas: CanvasId;
  mirror?: TopicMirror | undefined;
  children: ReactNode;
}) {
  return <Context value={{ canvas, mirror }}>{children}</Context>;
}

/** The mark on a graph card, for the canvas the graph shows. */
export function CardLeadBadge({ agent }: { agent: string }) {
  const context = useContext(Context);
  return context === null ? null : <LeadBadge {...context} agent={agent} />;
}

/** A card's mark that its agent leads (and that it is held, answering nothing). */
export function LeadBadge({
  canvas,
  agent,
  mirror,
}: {
  canvas: CanvasId;
  agent: string;
  mirror?: TopicMirror | undefined;
}) {
  const lead = leadOf(useTopic(`leads:${canvas}`, mirror), agent);
  if (lead === undefined) return null;
  return (
    <span
      className={lead.held === null ? 'lead-badge' : 'lead-badge lead-badge-held'}
      aria-label="Lead badge"
      title={
        lead.held === null
          ? 'Leads the agents nested in it'
          : 'Held: it answers nothing until you confirm it'
      }
    >
      {lead.held === null ? 'Lead' : 'Lead · held'}
    </span>
  );
}

/** One gesture's run: busy while it goes, its refusal shown. */
function useGesture() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await action();
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, perform };
}

/** The settings sheet's Lead section: grants, why it is held, Confirm and Remove. */
export function LeadSection({
  canvas,
  agent,
  mirror,
  client = api,
}: {
  canvas: CanvasId;
  agent: string;
  mirror?: TopicMirror | undefined;
  client?: GuiApi | undefined;
}) {
  const state = useTopic(`leads:${canvas}`, mirror);
  const { busy, problem, perform } = useGesture();
  // Only the core says who leads: nothing is shown before it has.
  if (state === undefined) return null;
  const lead = leadOf(state, agent);
  const set = (grants: LeadGrants | null) => {
    void perform(() =>
      client.agentSetLead({ canvas, agent, lead: grants === null ? null : { grants } }),
    );
  };
  return (
    <section className="lead-section" aria-label="Lead">
      <h3>Lead</h3>
      {lead === undefined ? (
        <>
          <p className="agent-settings-help">
            A lead answers for the agents nested in it, one request at a time and only what you
            allow. It never answers “always”.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              set(NONE);
            }}
          >
            Make a lead
          </button>
        </>
      ) : (
        <>
          {lead.held !== null && (
            <div role="status">
              <p>
                Held: {HELD_WORDS[lead.held]} since you made it a lead. It answers nothing and
                writes nothing for its team until you confirm it.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  set(lead.grants);
                }}
              >
                Confirm
              </button>
            </div>
          )}
          {GRANTS.map(([key, label]) => (
            <label key={key} className="lead-grant">
              <input
                type="checkbox"
                aria-label={label}
                checked={lead.grants[key]}
                disabled={busy || lead.held !== null}
                onChange={() => {
                  set({ ...lead.grants, [key]: !lead.grants[key] });
                }}
              />
              {label}
            </label>
          ))}
          <p className="agent-settings-help">
            Where its worker’s CLI sends no signal, a lead can only reject or hand back. You can
            answer any of its team’s requests first.
          </p>
          {lead.held === null && (
            <>
              <p className="agent-settings-help">Its lead tools appear when it next starts.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void perform(() => client.sessionRestart({ canvas, agent }));
                }}
              >
                Restart
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              set(null);
            }}
          >
            Remove lead
          </button>
        </>
      )}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}

/** The canvas menu's outside orchestrators: which may answer ordinary approvals, once each. */
export function OutsideGrants({
  canvas,
  mirror,
  client = api,
}: {
  canvas: CanvasId;
  mirror?: TopicMirror | undefined;
  client?: GuiApi | undefined;
}) {
  const state = useTopic(`leads:${canvas}`, mirror);
  const { busy, problem, perform } = useGesture();
  if (state === undefined || state.outside.length === 0) return null;
  return (
    <section className="outside-grants" aria-label="Outside orchestrators">
      <h3>Outside orchestrators</h3>
      <p className="agent-settings-help">
        An orchestrator you let answer approvals allows a request once, or rejects it. It never
        answers questions or plans, and never “always”.
      </p>
      {state.outside.map((one) => (
        <label key={one.name} className="outside-grant">
          <input
            type="checkbox"
            aria-label={`${one.name} may answer approvals`}
            checked={one.approvals}
            // A grant needs a live write token; taking one back never does.
            disabled={busy || (!one.approvals && !one.live)}
            onChange={() => {
              void perform(() =>
                client.outsideSetGrant({ canvas, name: one.name, approvals: !one.approvals }),
              );
            }}
          />
          {one.name}
          {one.live ? '' : ' · no live token'}
        </label>
      ))}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}
