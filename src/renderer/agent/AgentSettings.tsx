import { agentAdapter } from '../graph/agents';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDraft, useLabel } from '../useDraft';

import { adapterIn } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import { parseRole } from '../../shared/role';
import type { RoleSupport, SessionFeatures } from '../../shared/features';
import { MAX_ROLE_LENGTH } from '../../shared/session';
import type { AgentSettings, SettingsOptions } from '../../shared/session';
import { catalog, continuesIn } from '../catalog';
import { adapterName, connectionInfo, connectionOf } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import type { AgentNode } from '../../shared/model/canvas';
import { AgentChip } from './AgentChip';
import { SettingsMenu } from './Settings';
import type { Session } from '../../shared/model/session';
import './AgentSettings.css';
import { HandoffTile } from './Fallback';
import { WorkspaceDetails } from '../workspaces/Workspace';

type Options = (adapter: AdapterId) => Promise<SettingsOptions>;

/**
 * What an agent's connection does with its role: its ready generation's own report when there is
 * one, else its adapter's maximum (undefined for an adapter the catalog lacks). The one rule the
 * summary and the sheet share.
 */
function roleSupport(
  adapter: AdapterId | undefined,
  features: SessionFeatures | null,
): RoleSupport | undefined {
  return features?.role ?? adapterIn(catalog(), adapter)?.role;
}

/** The same saved settings summary in a session header and in its queue's heading. */
export function AgentSettingsSummary({
  node,
  options,
  features = null,
  onOpen,
}: {
  node: AgentNode;
  options: Options;
  /** What its ready generation can do, when there is one (else its adapter's maxima apply). */
  features?: SessionFeatures | null;
  onOpen: () => void;
}) {
  const name = node.data.label || 'Unnamed agent';
  const adapter = agentAdapter(node.data);
  const connection = connectionOf(node.data);
  const prefix =
    adapter === undefined
      ? 'Choose an agent'
      : `${adapterName(adapter)} · ${connectionInfo(connection).label}`;
  const role = node.data.role?.split(/\r?\n/)[0];
  // A role its adapter does nothing with is kept, but not shown as if it applied.
  const unused = role !== undefined && roleSupport(adapter, features) === 'none';
  const suffix = ` · ${unused ? 'Role not used' : (role ?? 'No role')}`;
  return (
    <div className="agent-settings-summary" title={node.data.role}>
      {connection === undefined || adapter === undefined ? (
        <button
          type="button"
          className="agent-settings-button"
          aria-label={`Agent settings: ${name}`}
          onClick={onOpen}
        >
          {prefix}
          {suffix}
        </button>
      ) : (
        <SettingsMenu
          adapter={adapter}
          connection={connection}
          settings={node.data.settings?.[adapter] ?? {}}
          options={options}
          running={undefined}
          working={false}
          onOpen={onOpen}
          label={`Agent settings: ${name}`}
          prefix={`${prefix} · `}
          suffix={suffix}
        />
      )}
    </div>
  );
}

/** Saved agent identity, connection, standing instructions and native startup settings. */
export function AgentSettingsPanel({
  inert = false,
  lead,
  node,
  session,
  options,
  onRename,
  onRole,
  onAgent,
  onSettings,
  onRestart,
  onFresh,
  onClose,
}: {
  inert?: boolean;
  /** B24 X2: the Lead section (leads/Leads.tsx), which the graph provides for its canvas. */
  lead?: ReactNode;
  node: AgentNode;
  session: Session;
  options: Options;
  onRename: (name: string) => void;
  onRole: (role: string | undefined) => unknown;
  onAgent: (adapter: AdapterId, connection: AgentConnection) => void;
  onSettings: (adapter: AdapterId, settings: AgentSettings) => void;
  onRestart: () => void;
  onFresh: () => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const { problem: titleProblem, ...title } = useLabel(node.data.label, onRename);
  const { problem, ...role } = useDraft(node.data.role ?? '', (raw) => onRole(parseRole(raw)), {
    multiline: true,
    validate: parseRole,
  });
  const name = node.data.label || 'Unnamed agent';
  const adapter = agentAdapter(node.data);
  const connection = connectionOf(node.data);
  const settings =
    connection === undefined || adapter === undefined ? {} : (node.data.settings?.[adapter] ?? {});
  const running = session.running;
  // What the connection can do: its running generation's own report, else its adapter's maxima
  // (B16 C1/C4). A restart is refused for one that cannot resume, as the core decides it (a
  // generation that has not reported does not refuse it).
  const maxima = adapterIn(catalog(), adapter);
  const effective = session.features ?? null;
  const roleKind = roleSupport(adapter, effective);
  const resumes = maxima?.resume === true && effective?.resume !== false;
  // A role it does nothing with is kept in the canvas, never edited here or called applied.
  const unusedRole = roleKind === 'none';
  // A resumed conversation keeps the role it started with: a changed role needs a new one.
  const keepsRole = roleKind === 'append-new' && resumes;
  const changedRole = !unusedRole && running !== undefined && running.role !== node.data.role;
  const idle = session.status === 'idle';
  const pending =
    connection !== undefined &&
    adapter !== undefined &&
    running !== undefined &&
    (changedRole ||
      running.model !== settings.model ||
      running.effort !== settings.effort ||
      running.mode !== settings.mode);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    sheet.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    // A menu choice can remove the focused element. Escape still belongs to this sheet then.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        event.target instanceof Element &&
        (event.target.closest('[data-draft], .search-picker, .fallback-dialog') ||
          event.target.closest('.agent-choice')?.querySelector('[aria-expanded="true"]'))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="agent-settings-backdrop"
      inert={inert}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheet}
        className="agent-settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Agent settings: ${name}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input, textarea, [tabindex="0"]',
              ),
            ];
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>Agent settings</h2>
          <button
            type="button"
            className="agent-settings-close"
            aria-label="Close agent settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <label className="agent-settings-field">
          Name
          <input aria-label="Name" {...title} placeholder="Unnamed agent" />
        </label>
        {titleProblem && <p role="alert">{titleProblem}</p>}
        <div className="agent-settings-connection">
          <span>CLI and connection</span>
          <AgentChip
            agentId={node.id}
            adapter={adapter}
            connection={connection}
            onChange={onAgent}
            onContinue={() => {
              if (adapter !== undefined && connection !== undefined)
                onAgent(adapter, continuesIn(connection) ?? connection);
            }}
          />
        </div>
        <p className="agent-settings-help">{connectionInfo(connection).description}.</p>
        <WorkspaceDetails agent={node.id} />
        <HandoffTile agent={node.id} />
        {lead}
        <label className="agent-settings-field">
          Role
          <textarea
            aria-label="Role"
            aria-describedby="agent-role-help"
            {...role}
            disabled={unusedRole}
            aria-invalid={problem !== undefined}
            maxLength={MAX_ROLE_LENGTH}
            rows={6}
            placeholder="For example: Review changes for correctness and explain concrete risks."
          />
        </label>
        <p id="agent-role-help" className="agent-settings-help">
          {unusedRole
            ? `${adapterName(adapter)} doesn’t apply a role through this connection, so this text is kept in this canvas and not applied.`
            : 'Standing instructions for this agent, saved with the workflow. Applied when its session starts or restarts.'}
        </p>
        {problem && (
          <p className="agent-settings-problem" role="alert">
            {problem}
          </p>
        )}
        {connection !== undefined && adapter !== undefined && (
          <SettingsMenu
            inline
            adapter={adapter}
            connection={connection}
            settings={settings}
            options={options}
            running={undefined}
            working={!idle}
            resumes={resumes}
            onChange={(next) => {
              onSettings(adapter, next);
            }}
            onRestart={onRestart}
            onFresh={onFresh}
          />
        )}
        {pending && !(keepsRole && changedRole) && (
          <div className="agent-settings-pending" role="status">
            {resumes ? (
              <>
                <p>Changes saved. Restart this session to apply them, keeping its conversation.</p>
                <button type="button" disabled={!idle} onClick={onRestart}>
                  Restart with these
                </button>
              </>
            ) : (
              <>
                <p>
                  Changes saved. {adapterName(adapter)} can’t continue its earlier conversation, so
                  a new conversation applies them; the earlier one stays in its history.
                </p>
                <button type="button" disabled={!idle} onClick={onFresh}>
                  Start new conversation
                </button>
              </>
            )}
            {!idle && <p>Available when the current turn finishes.</p>}
          </div>
        )}
        {keepsRole && (
          <div className="agent-settings-pending">
            <p>
              {adapterName(adapter)} keeps a conversation’s original role when it resumes. Start a
              new conversation to apply a changed role; the earlier conversation stays in{' '}
              {adapterName(adapter)}’s history.
            </p>
            <button type="button" disabled={!idle} onClick={onFresh}>
              {node.data.role ? 'Start new conversation with this role' : 'Start new conversation'}
            </button>
            {!idle && <p>Available when the current turn finishes.</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
