import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDraft, useLabel } from '../useDraft';

import { adapterIn } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import { parseRole } from '../../shared/role';
import { MAX_ROLE_LENGTH } from '../../shared/session';
import type { AgentSettings, SettingsOptions } from '../../shared/session';
import { catalog, continuesIn } from '../catalog';
import { adapterName, connectionInfo, connectionOf, DEFAULT_AGENT } from '../graph/agents';
import type { AgentConnection } from '../graph/agents';
import type { AgentNode } from '../../shared/model/canvas';
import { AgentChip } from './AgentChip';
import { SettingsMenu } from './Settings';
import type { Session } from '../../shared/model/session';
import './AgentSettings.css';

type Options = (adapter: AdapterId) => Promise<SettingsOptions>;

/** The same saved settings summary in a session header and in its queue's heading. */
export function AgentSettingsSummary({
  node,
  options,
  onOpen,
}: {
  node: AgentNode;
  options: Options;
  onOpen: () => void;
}) {
  const name = node.data.label || 'Unnamed agent';
  const adapter = node.data.adapter ?? DEFAULT_AGENT;
  const connection = connectionOf(node.data);
  const prefix = `${adapterName(adapter)} · ${connectionInfo(connection).label}`;
  const role = node.data.role?.split(/\r?\n/)[0];
  const suffix = ` · ${role ?? 'No role'}`;
  return (
    <div className="agent-settings-summary" title={node.data.role}>
      {connection === 'unavailable' ? (
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
  node: AgentNode;
  session: Session;
  options: Options;
  onRename: (name: string) => void;
  onRole: (role: string | undefined) => void;
  onAgent: (adapter: AdapterId, connection: AgentConnection) => void;
  onSettings: (adapter: AdapterId, settings: AgentSettings) => void;
  onRestart: () => void;
  onFresh: () => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string>();
  const title = useLabel(node.data.label, onRename);
  const role = useDraft(
    node.data.role ?? '',
    (raw) => {
      try {
        onRole(parseRole(raw));
        setProblem(undefined);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'Invalid role');
      }
    },
    { multiline: true },
  );
  const name = node.data.label || 'Unnamed agent';
  const adapter = node.data.adapter ?? DEFAULT_AGENT;
  const connection = connectionOf(node.data);
  const settings = connection === 'unavailable' ? {} : (node.data.settings?.[adapter] ?? {});
  const running = session.running;
  // A resumed conversation keeps the role it started with: a changed role needs a new one.
  const keepsRole = adapterIn(catalog(), adapter)?.role === 'append-new';
  const changedRole = running !== undefined && running.role !== node.data.role;
  const pending =
    connection !== 'unavailable' &&
    running !== undefined &&
    (running.role !== node.data.role ||
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
        (event.target.closest('[data-draft], .search-picker') ||
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
        <div className="agent-settings-connection">
          <span>CLI and connection</span>
          <AgentChip
            adapter={adapter}
            connection={connection}
            onChange={onAgent}
            onContinueInTerminal={() => {
              onAgent(adapter, continuesIn(connection) ?? connection);
            }}
          />
        </div>
        <p className="agent-settings-help">{connectionInfo(connection).description}.</p>
        <label className="agent-settings-field">
          Role
          <textarea
            aria-label="Role"
            aria-describedby="agent-role-help"
            aria-invalid={problem !== undefined}
            {...role}
            maxLength={MAX_ROLE_LENGTH}
            rows={6}
            placeholder="For example: Review changes for correctness and explain concrete risks."
            onChange={(event) => {
              role.onChange(event);
              try {
                parseRole(event.target.value);
                setProblem(undefined);
              } catch (error) {
                setProblem(error instanceof Error ? error.message : 'Invalid role');
              }
            }}
            onBlur={() => {
              role.onBlur();
              setProblem(undefined);
            }}
            onKeyDown={(event) => {
              role.onKeyDown(event);
              if (event.key === 'Escape') setProblem(undefined);
            }}
          />
        </label>
        <p id="agent-role-help" className="agent-settings-help">
          Standing instructions for this agent, saved with the workflow. Applied when its session
          starts or restarts.
        </p>
        {problem && (
          <p className="agent-settings-problem" role="alert">
            {problem}
          </p>
        )}
        {connection !== 'unavailable' && (
          <SettingsMenu
            inline
            adapter={adapter}
            connection={connection}
            settings={settings}
            options={options}
            running={undefined}
            working={session.status !== 'idle'}
            onChange={(next) => {
              onSettings(adapter, next);
            }}
            onRestart={onRestart}
          />
        )}
        {pending && !(keepsRole && changedRole) && (
          <div className="agent-settings-pending" role="status">
            <p>Changes saved. Restart this session to apply them, keeping its conversation.</p>
            <button type="button" disabled={session.status !== 'idle'} onClick={onRestart}>
              Restart with these
            </button>
            {session.status !== 'idle' && <p>Available when the current turn finishes.</p>}
          </div>
        )}
        {keepsRole && (
          <div className="agent-settings-pending">
            <p>
              {adapterName(adapter)} keeps a conversation’s original role when it resumes. Start a
              new conversation to apply a changed role; the earlier conversation stays in{' '}
              {adapterName(adapter)}’s history.
            </p>
            <button type="button" disabled={session.status !== 'idle'} onClick={onFresh}>
              {node.data.role ? 'Start new conversation with this role' : 'Start new conversation'}
            </button>
            {session.status !== 'idle' && <p>Available when the current turn finishes.</p>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
