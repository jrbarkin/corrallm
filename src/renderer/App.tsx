import { useEffect, useState } from 'react';

import type { SessionBackend } from './agent/connected';
import { GraphEditor } from './graph/GraphEditor';
import type { CanvasFiles } from './graph/GraphEditor';
import { OpenLinkContext } from './open-link';
import type { OpenLink } from './open-link';
import type { TerminalBackend } from './terminal/backend';

/**
 * Canvases are opened and saved by the main process (src/main/canvas.ts), which also keeps the
 * folder their agents work in (src/main/project.ts).
 */
const files: CanvasFiles = {
  open: () => window.api.openCanvas(),
  save: (text, choose) => window.api.saveCanvas(text, choose),
  forget: () => window.api.forgetCanvas(),
  chooseProject: () => window.api.chooseProject(),
};

/** Connected agents' sessions run in the main process (src/main/sessions/). */
const sessionBackend: SessionBackend = {
  start: (agentId, options) => window.api.startSession(agentId, options),
  send: (agentId, message) => window.api.sendToSession(agentId, message),
  answer: (agentId, promptId, answer) => window.api.answerSession(agentId, promptId, answer),
  interrupt: (agentId) => window.api.interruptSession(agentId),
  setMode: (agentId, mode) => window.api.setSessionMode(agentId, mode),
  setModel: (agentId, model) => window.api.setSessionModel(agentId, model),
  close: (agentId) => window.api.closeSession(agentId),
  files: (query) => window.api.findProjectFiles(query),
  onEvent: (listener) => window.api.onSessionEvent(listener),
};

/** Terminal agents' terminals run in the main process (src/main/sessions/terminal/). */
const terminalBackend: TerminalBackend = {
  attach: (agentId) => window.api.attachTerminal(agentId),
  detach: (agentId) => window.api.detachTerminal(agentId),
  write: (agentId, data) => window.api.writeTerminal(agentId, data),
  resize: (agentId, cols, rows) => window.api.resizeTerminal(agentId, cols, rows),
  onEvent: (listener) => window.api.onTerminalEvent(listener),
};

/** Links clicked in the app open in the browser if main says so (src/main/links.ts). */
const openLink: OpenLink = (url) => {
  window.api.openLink(url).catch(() => undefined);
};

type PingState =
  { status: 'pending' } | { status: 'ok'; version: string } | { status: 'error'; message: string };

export function App() {
  const [ping, setPing] = useState<PingState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    window.api.ping().then(
      (version) => {
        if (!cancelled) setPing({ status: 'ok', version });
      },
      (error: unknown) => {
        if (!cancelled) {
          setPing({
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
        <p data-testid="ping-result" data-status={ping.status}>
          {ping.status === 'pending' && 'Pinging main process…'}
          {ping.status === 'ok' && ping.version}
          {ping.status === 'error' && `Ping failed: ${ping.message}`}
        </p>
      </header>
      <OpenLinkContext.Provider value={openLink}>
        <GraphEditor
          files={files}
          sessionBackend={sessionBackend}
          terminalBackend={terminalBackend}
        />
      </OpenLinkContext.Provider>
    </main>
  );
}
