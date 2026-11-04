import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { consentIn } from '../../shared/adapter';
import type { ConsentTarget } from '../../shared/api/ops/settings';
import type { GuiApi } from '../../shared/gui-link';
import { DefaultAgentControl } from '../DefaultAgentControl';
import { api } from '../api/client';
import { topics, useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { animate } from '../agent/motion';
import { catalog } from '../catalog';
import { ipcErrorMessage } from '../ipc-error';
import './SettingsPage.css';

type Intent = NonNullable<Parameters<GuiApi['settingsSet']>[0]>;

const DELIVERY = {
  shown: 'Last notification shown',
  suppressed: 'Last notification was suppressed',
  unsupported: "OS notifications aren't supported here",
  failed: "The last notification couldn't be shown",
} as const;
const NO_DELIVERY = 'No notification attempted since corrallm started';

/**
 * One writable row at a time: each gesture is one `settings.set`; its row alone is disabled while
 * the call is pending, and a refusal is kept at that row (with the retry) until the next attempt.
 */
function useRows(client: Pick<GuiApi, 'settingsSet'>) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const busy = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const send = async (row: string, intent: Intent) => {
    if (busy.current.has(row)) return;
    busy.current.add(row);
    setPending(new Set(busy.current));
    setProblems((was) => Object.fromEntries(Object.entries(was).filter(([name]) => name !== row)));
    try {
      await client.settingsSet(intent);
    } catch (error) {
      if (alive.current) setProblems((was) => ({ ...was, [row]: ipcErrorMessage(error) }));
    } finally {
      busy.current.delete(row);
      if (alive.current) setPending(new Set(busy.current));
    }
  };
  return { pending, problems, send };
}

const adapterKey = (adapter: string, key: string) => `consent:${adapter}:${key}`;

/**
 * The app's Settings, a foreground panel over the canvas (not a modal): it shows only what the
 * settings topic holds, one operation per gesture, and closing it is local navigation.
 */
export function SettingsPage({
  client = api,
  mirror = topics,
  onClose,
}: {
  client?: Pick<GuiApi, 'settingsSet'>;
  mirror?: TopicMirror;
  onClose: () => void;
}) {
  const settings = useTopic('settings', mirror);
  // Between a reconnect and the new epoch's snapshot the last complete page stays, inert.
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => mirror.subscribe('settings', listener), [mirror]),
    () => mirror.revision('settings'),
  );
  const current = settings !== undefined && revision !== undefined;
  const { pending, problems, send } = useRows(client);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = panel.current;
    element?.focus();
    const motion =
      element &&
      animate(
        element,
        [
          { opacity: 0, transform: 'translate(-50%, -48%) scale(0.97)' },
          { opacity: 1, transform: 'translate(-50%, -50%)' },
        ],
        { duration: 240, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' },
      );
    return () => {
      if (motion) {
        void motion.finished.catch(() => undefined);
        motion.cancel();
      }
    };
  }, []);
  const take = (row: string, target: ConsentTarget) => {
    void send(row, { consent: target });
  };
  const problem = (row: string): ReactNode =>
    problems[row] !== undefined && <p role="alert">{problems[row]}</p>;

  const notifications = settings?.notifications;
  const enabled = notifications?.enabled ?? true;
  const delivery = notifications?.lastDelivery ? DELIVERY[notifications.lastDelivery] : NO_DELIVERY;

  const declared = catalog().adapters.flatMap((adapter) =>
    (adapter.consents ?? []).map((consent) => ({ adapter, consent })),
  );
  const undeclared = Object.entries(settings?.consents ?? {}).flatMap(([adapter, keys]) =>
    Object.keys(keys)
      .filter((key) => consentIn(catalog(), adapter, key) === undefined)
      .map((key) => ({ adapter, key })),
  );

  const links = settings?.links;
  return (
    <div
      className="graph-detail-backdrop graph-start-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={panel}
        className="settings-page"
        role="dialog"
        aria-modal="false"
        aria-label="Settings"
        tabIndex={-1}
      >
        <header className="settings-page-header">
          <div>
            <h2>Settings</h2>
            <p>For corrallm on this machine.</p>
          </div>
          <button type="button" aria-label="Close Settings" onClick={onClose}>
            Back
          </button>
        </header>
        <div className="settings-page-body">
          <section aria-labelledby="settings-default">
            <h3 id="settings-default">Default agent</h3>
            <p>For new agents; existing agents keep their choices.</p>
            <DefaultAgentControl client={client} mirror={mirror} disabled={!current} />
          </section>

          <section aria-label="Notifications" aria-labelledby="settings-notifications">
            <h3 id="settings-notifications">Notifications</h3>
            <label className="settings-switch">
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={!current || pending.has('notifications')}
                onChange={() => {
                  void send('notifications', { notifications: { enabled: !enabled } });
                }}
              />
              OS notifications
            </label>
            <p>When corrallm is in the background, for work that needs you and runs that end.</p>
            <p role="status">{delivery}</p>
            {problem('notifications')}
          </section>

          <section aria-labelledby="settings-consents">
            <h3 id="settings-consents">Consents</h3>
            {declared.length === 0 && undeclared.length === 0 ? (
              <p>No consents to review.</p>
            ) : (
              <>
                <p>
                  A turn already running can finish; before the next turn uses it, corrallm asks
                  again.
                </p>
                <ul aria-label="Consents">
                  {declared.map(({ adapter, consent }) => {
                    const row = adapterKey(adapter.id, consent.key);
                    const kept = settings?.consents[adapter.id]?.[consent.key] === true;
                    const where = consent.connections
                      .map((id) => adapter.connections.find((one) => one.id === id)?.label ?? id)
                      .join(', ');
                    return (
                      <li key={row}>
                        <div>
                          <strong>{adapter.name}</strong> <span>{where}</span>
                        </div>
                        <div>{consent.title}</div>
                        <div>{consent.description}</div>
                        <div>{kept ? 'Kept for good' : 'Not kept for good'}</div>
                        <button
                          type="button"
                          aria-label={`Ask again: ${consent.title} (${adapter.name})`}
                          disabled={!current || pending.has(row)}
                          onClick={() => {
                            take(row, { kind: 'adapter', adapter: adapter.id, key: consent.key });
                          }}
                        >
                          Ask again
                        </button>
                        {problem(row)}
                      </li>
                    );
                  })}
                  {undeclared.map(({ adapter, key }) => {
                    const row = adapterKey(adapter, key);
                    return (
                      <li key={row}>
                        <div>{`${adapter} · ${key}`}</div>
                        <div>Kept, but this version of corrallm does not describe it.</div>
                        <button
                          type="button"
                          aria-label={`Remove saved consent ${adapter} · ${key}`}
                          disabled={!current || pending.has(row)}
                          onClick={() => {
                            take(row, { kind: 'adapter', adapter, key });
                          }}
                        >
                          Remove
                        </button>
                        {problem(row)}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          <section aria-labelledby="settings-links">
            <h3 id="settings-links">Links that open without asking</h3>
            {links === undefined && <p role="status">Loading…</p>}
            {links?.state === 'unavailable' && <p role="status">{links.sentence}</p>}
            {links?.state === 'ready' && (
              <>
                {links.sites.length === 0 ? (
                  <p>No sites remembered.</p>
                ) : (
                  <ul aria-label="Remembered sites">
                    {links.sites.map((origin) => {
                      const row = `site:${origin}`;
                      return (
                        <li key={origin}>
                          <span className="settings-origin">{origin}</span>
                          <button
                            type="button"
                            aria-label={`Ask next time: ${origin}`}
                            disabled={!current || pending.has(row)}
                            onClick={() => {
                              take(row, { kind: 'site', origin });
                            }}
                          >
                            Ask next time
                          </button>
                          {problem(row)}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {links.builtIn.length > 0 && (
                  <>
                    <p>These always open without asking, and can’t be taken back.</p>
                    <ul aria-label="Always open without asking">
                      {links.builtIn.map((origin) => (
                        <li key={origin}>
                          <span className="settings-origin">{origin}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
