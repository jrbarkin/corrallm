import { useEffect, useState } from 'react';

import type { SessionBackend } from '../shared/engine/transcript/receive';
import { GraphEditor } from './graph/GraphEditor';
import type { CanvasFiles } from './graph/GraphEditor';
import { fromMain } from './ipc-error';
import { OpenLinkContext, openLinkWith } from './open-link';
import type { OpenLink } from './open-link';
import type { TerminalBackend } from './terminal/backend';
import type { UsageSource } from './usage/store';
import type { RunSource } from './run/persistence';

const runSource: RunSource = {
  get: () => window.api.getRun(),
  save: (token, checkpoint) => window.api.saveRun(token, checkpoint),
  ready: (request, error) => window.api.runReady(request, error),
  onStopping: (listener) => window.api.onRunStopping(listener),
};

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
  start: (agentId, options) => fromMain(window.api.startSession(agentId, options)),
  installed: () => fromMain(window.api.installedClis()),
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
  files: (query) => fromMain(window.api.findProjectFiles(query)),
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

/** Terminal agents' terminals run in the main process (src/main/sessions/terminal/). */
const terminalBackend: TerminalBackend = {
  attach: (agentId) => window.api.attachTerminal(agentId),
  detach: (agentId) => window.api.detachTerminal(agentId),
  write: (agentId, data) => window.api.writeTerminal(agentId, data),
  resize: (agentId, cols, rows) => window.api.resizeTerminal(agentId, cols, rows),
  drop: (agentId, files) => window.api.dropOnTerminal(agentId, files),
  onEvent: (listener) => window.api.onTerminalEvent(listener),
};

/**
 * Links clicked in the app open in the browser if main says so (src/main/host/links.ts); a file://
 * link's file is shown in the file manager if it is in the project folder (src/main/host/reveal.ts).
 */
const openLink: OpenLink = openLinkWith(() => window.api);

/** Usage readings and rules are main's (src/main/usage.ts): one per backend, for every canvas. */
const usageSource: UsageSource = {
  get: () => window.api.getUsage(),
  setRule: (backend, rule) => window.api.setUsageRule(backend, rule),
  simulate: (backend, windows) => window.api.simulateUsage(backend, windows),
  onChanged: (listener) => window.api.onUsageChanged(listener),
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
          usageSource={usageSource}
          runSource={runSource}
        />
      </OpenLinkContext.Provider>
    </main>
  );
}
