import { useEffect, useState } from 'react';

import { api } from './api/client';
import { GraphEditor } from './graph/GraphEditor';
import { OpenLinkContext, openLinkWith } from './open-link';
import type { OpenLink } from './open-link';
import type { TerminalBackend } from './terminal/backend';
import { topics } from './api/topics';
import type { UsageSource } from './usage/store';
<<<<<<< HEAD
=======
import type { RunSource } from './run/persistence';

/**
 * The window's run, journaled by the core: read once the editor's mirror holds the canvas shown
 * (B9 Design §9), and saved without the document, which is the core's.
 */
const runSource: RunSource = {
  get: () => window.api.getRun(),
  save: (token, checkpoint) => window.api.saveRun(token, checkpoint),
  ready: (request, error) => window.api.runReady(request, error),
  onStopping: (listener) => window.api.onRunStopping(listener),
};

/** Connected agents' sessions run in the core process (src/main/sessions/). */
const sessionBackend: SessionBackend = {
  availability: (agent) => fromMain(window.api.sessionAvailability(agent)),
  onAvailability: (listener) => window.api.onSessionAvailability(listener),
  start: (agentId, options) => fromMain(window.api.startSession(agentId, options)),
  installed: () => api.catalogInstalled(),
  send: (agentId, message) => fromMain(window.api.sendToSession(agentId, message)),
  answer: (agentId, promptId, answer) =>
    fromMain(window.api.answerSession(agentId, promptId, answer)),
  interrupt: (agentId) => fromMain(window.api.interruptSession(agentId)),
  setMode: (agentId, mode) => fromMain(window.api.setSessionMode(agentId, mode)),
  setModel: (agentId, model) => fromMain(window.api.setSessionModel(agentId, model)),
  setEffort: (agentId, effort) => fromMain(window.api.setSessionEffort(agentId, effort)),
  stopTask: (agentId, taskId) => fromMain(window.api.stopSessionTask(agentId, taskId)),
  close: (agentId) => fromMain(window.api.closeSession(agentId)),
  fresh: (agentId, adapter) => fromMain(window.api.freshSession(agentId, adapter)),
  files: findProjectFiles,
  options: (adapter, agent) =>
    fromMain(window.api.settingsOptions(adapter, ...(agent === undefined ? [] : [agent]))),
  sessions: (agentId) => fromMain(window.api.listSessions(agentId)),
  resume: (agentId, sessionId) => fromMain(window.api.resumeSession(agentId, sessionId)),
  previewRewind: (agentId, messageId) => fromMain(window.api.previewRewind(agentId, messageId)),
  rewind: (agentId, messageId, restore) =>
    fromMain(window.api.rewindSession(agentId, messageId, restore)),
  mcp: (agentId) => fromMain(window.api.mcpServers(agentId)),
  changeMcp: (agentId, server, change) =>
    fromMain(window.api.changeMcpServer(agentId, server, change)),
  onEvent: (listener) => window.api.onSessionEvent(listener),
};
>>>>>>> origin/main

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
