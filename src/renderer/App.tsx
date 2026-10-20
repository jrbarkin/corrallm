import { useEffect, useState } from 'react';

import { canvasIdOf } from '../shared/canvas';
import type { CanvasId } from '../shared/canvas';
import type { SessionBackend } from '../shared/engine/transcript/receive';
import { api } from './api/client';
import { findProjectFiles } from './agent/completion';
import { GraphEditor } from './graph/GraphEditor';
import type { CanvasFiles } from './graph/GraphEditor';
import { fromMain } from './ipc-error';
import { OpenLinkContext, openLinkWith } from './open-link';
import type { OpenLink } from './open-link';
import type { TerminalBackend } from './terminal/backend';
import { ApiError } from './api/bridge';
import { topics } from './api/topics';
import type { UsageSource } from './usage/store';
import type { RunSource } from './run/persistence';

const runSource: RunSource = {
  get: async () => {
    const { canvas } = await api.windowGet();
    await topics.whenAt(`canvas:${canvas as CanvasId}`, 0);
    const context = await window.api.getRun();
    return { ...context, id: canvas as CanvasId };
  },
  save: async (token, checkpoint, document, rev) => {
    const result = await window.api.saveRun(token, checkpoint, document, rev);
    if (!result.ok) throw new ApiError(result.error);
    await topics.whenAt(`canvas:${canvasIdOf(document)}`, result.value.rev);
    return result.value.rev;
  },
  ready: (request, error) => window.api.runReady(request, error),
  onStopping: (listener) => window.api.onRunStopping(listener),
};

/**
 * Canvases are opened and saved by the core process (src/main/canvas.ts), which also keeps the
 * folder their agents work in (src/main/project.ts).
 */
const files: CanvasFiles = {
  open: () => window.api.openCanvas(),
  save: async (text, choose, rev) => {
    const result = await window.api.saveCanvas(text, choose, rev);
    if (!result.ok) throw new ApiError(result.error);
    return result.value.name;
  },
  forget: () => window.api.forgetCanvas(),
  chooseProject: () => window.api.chooseProject(),
};

/** Connected agents' sessions run in the core process (src/main/sessions/). */
const sessionBackend: SessionBackend = {
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
  options: (adapter) => fromMain(window.api.settingsOptions(adapter)),
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
        <GraphEditor
          files={files}
          sessionBackend={sessionBackend}
          terminalBackend={terminalBackend}
          usageSource={usageSource}
          runSource={runSource}
        />
      </OpenLinkContext.Provider>
    </main>
  );
}
