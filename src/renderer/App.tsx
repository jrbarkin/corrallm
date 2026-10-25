import { useEffect, useState } from 'react';

import { api } from './api/client';
import { GraphEditor } from './graph/GraphEditor';
import { OpenLinkContext, openLinkWith } from './open-link';
import type { OpenLink } from './open-link';
import type { TerminalBackend } from './terminal/backend';
import { topics } from './api/topics';
import type { UsageSource } from './usage/store';

/** Terminal agents' terminals run in the core process (src/main/sessions/terminal/). */
const done = (call: Promise<unknown>) => call.then(() => null);
const terminalBackend: TerminalBackend = {
  attach: (agentId) => done(api.terminalAttach({ agent: agentId })),
  detach: (agentId) => done(api.terminalDetach({ agent: agentId })),
  write: (agentId, data) => done(api.terminalInput({ agent: agentId, data })),
  resize: (agentId, cols, rows) => done(api.terminalResize({ agent: agentId, cols, rows })),
  drop: (agentId, files) => done(api.terminalDrop({ agent: agentId, files })),
  onEvent: (listener) => api.terminalOnEvent(listener),
};

/**
 * Links clicked in the app open in the browser if the core says so (src/main/links.ts); a file://
 * link's file is shown in the file manager if it is in the project folder (src/main/reveal.ts).
 */
const openLink: OpenLink = openLinkWith(() => api);

/** Usage readings and rules are the core's (src/main/usage.ts): one per backend, for every canvas. */
const usageSource: UsageSource = {
  topics,
  setRule: (backend, rule) => api.usageSetRule({ backend, rule }),
  simulate: (backend, windows) => api.usageSimulate({ backend, windows }),
};

/** Which corrallm this is, as its core says (app.info), once it has. */
type InfoState =
  | { status: 'pending' }
  | { status: 'ok'; name: string; version: string }
  | { status: 'error'; message: string };

export function App() {
  const [info, setInfo] = useState<InfoState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    api.appInfo().then(
      ({ name, version }) => {
        if (!cancelled) setInfo({ status: 'ok', name, version });
      },
      (error: unknown) => {
        if (!cancelled) {
          setInfo({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <h1>corrallm</h1>
        <p data-testid="app-info" data-status={info.status}>
          {info.status === 'pending' && 'Asking corrallm’s core…'}
          {info.status === 'ok' && `${info.name} ${info.version}`}
          {info.status === 'error' && `corrallm’s core didn’t answer: ${info.message}`}
        </p>
      </header>
      <OpenLinkContext.Provider value={openLink}>
        <GraphEditor terminalBackend={terminalBackend} usageSource={usageSource} />
      </OpenLinkContext.Provider>
    </main>
  );
}
