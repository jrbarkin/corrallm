import { useEffect, useRef, useState } from 'react';
import type { AdapterId, ConnectionId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import type { ProjectFolder } from '../../shared/ipc';
import type { InstalledClis } from '../../shared/session';
import type { TemplateInfo } from '../../shared/templates';
import { api } from '../api/client';
import { useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { catalog } from '../catalog';
import { AdapterLogo } from '../AdapterLogo';
import { ipcErrorMessage } from '../ipc-error';
import { animate } from '../agent/motion';
import './StartSession.css';

/** A window over the canvas: start an installed CLI, use a template, or return to kept work. */
export function StartSession({ canvas, mirror, project, installed, onStart, onChooseProject, onTemplate, onShow, onClose }: {
  canvas: CanvasId; mirror: TopicMirror; project: ProjectFolder | null;
  installed: InstalledClis | undefined;
  onStart: (adapter: AdapterId, connection: ConnectionId, from: DOMRect) => Promise<void>;
  onChooseProject: () => void;
  onTemplate: (template: TemplateInfo) => void;
  onShow: (canvas: CanvasId) => Promise<void>;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [connections, setConnections] = useState<Readonly<Record<string, string>>>({});
  const [templates, setTemplates] = useState<TemplateInfo[]>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const recent = useTopic('canvases', mirror);
  useEffect(() => {
    let live = true;
    void api.templatesList().then(({ items }) => { if (live) setTemplates(items); }, (error: unknown) => { if (live) setProblem(ipcErrorMessage(error)); });
    const element = panel.current;
    element?.focus();
    const motion = element && animate(element, [{ opacity: 0, transform: 'translate(-50%, -48%) scale(0.97)' }, { opacity: 1, transform: 'translate(-50%, -50%)' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' });
    return () => { live = false; if (motion) { void motion.finished.catch(() => undefined); motion.cancel(); } };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setProblem(undefined);
    try { await action(); } catch (error) { setProblem(ipcErrorMessage(error)); } finally { setBusy(false); }
  };
  return <div className="graph-detail-backdrop graph-start-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
  }}>
    <div ref={panel} className="start-session" role="dialog" aria-modal="false" aria-label="Start a session" tabIndex={-1}>
      <header className="start-session-header"><h2>Start a session</h2><button type="button" aria-label="Close Start a session" disabled={busy} onClick={onClose}>×</button></header>
      <div className="start-session-body">
        <div className="start-session-folder"><div><strong>{project?.name ?? 'Project folder'}</strong><span>{project?.path ?? 'Choose where this canvas’s agents work.'}</span></div>
          <button type="button" aria-label={project ? `Project folder: ${project.name}` : 'Choose a project folder'} disabled={busy} onClick={onChooseProject}>{project ? 'Change folder…' : 'Choose a project folder'}</button>
        </div>
        <section aria-label="Agents to start"><h3>Your agents</h3>
          {installed === undefined && <p role="status">Looking for installed agents…</p>}
          {catalog().adapters.map((adapter) => {
            const choices = [...adapter.connections].sort((a, b) => Number(b.view === 'terminal') - Number(a.view === 'terminal'));
            const connection = connections[adapter.id] ?? choices[0]?.id;
            return <div className="start-session-agent" key={adapter.id}>
              <AdapterLogo adapter={adapter.id} size={30} />
              <div><strong>{adapter.name}</strong><select aria-label={`${adapter.name} connection`} value={connection ?? ''} disabled={busy || !installed?.[adapter.id]} onChange={(event) => { setConnections((previous) => ({ ...previous, [adapter.id]: event.target.value })); }}>{choices.map((one) => <option key={one.id} value={one.id}>{one.label}</option>)}</select>
                {installed?.[adapter.id] === false && <span>Not installed</span>}
              </div>
              <button type="button" aria-label={`Start ${adapter.name}`} disabled={busy || !installed?.[adapter.id] || connection === undefined} onClick={() => {
                const from = panel.current?.getBoundingClientRect();
                if (from && connection) void perform(() => onStart(adapter.id, connection, from));
              }}>Start</button>
            </div>;
          })}
        </section>
        <div className="start-session-links">
          <section aria-label="Templates"><h3>Templates</h3>{templates?.map((template) => <button type="button" key={template.id} title={template.description} disabled={busy} onClick={() => { onTemplate(template); }}>{template.name}</button>)}{templates === undefined && <p>Loading templates…</p>}</section>
          <section aria-label="Recent canvases"><h3>Recent canvases</h3>{recent?.items.filter((item) => item.canvas !== canvas).map((item) => <button type="button" key={item.canvas} aria-label={`Show ${item.name ?? 'Untitled'}`} disabled={busy} onClick={() => { void perform(() => onShow(item.canvas as CanvasId)); }}><strong>{item.name ?? 'Untitled'}</strong>{item.project && <span>{item.project.name}</span>}{item.edited && <span>Edited</span>}</button>)}{recent?.items.filter((item) => item.canvas !== canvas).length === 0 && <p>No recent canvases.</p>}</section>
        </div>
      </div>
      {problem && <p role="alert">{problem}</p>}
    </div>
  </div>;
}
