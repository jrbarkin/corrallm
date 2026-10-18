import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdapterId } from '../../shared/adapter';
import { MAX_ROLE_LENGTH } from '../../shared/session';
import type { AgentSettings, SettingsOptions } from '../../shared/session';
import type { AgentConnection } from '../graph/agents';
import { setAgent, setConnection, setRole } from '../graph/graph';
import type { GraphNode } from '../graph/graph';
import { AgentSettingsPanel, AgentSettingsSummary } from './AgentSettings';
import { NEW_SESSION } from './session';
import type { Session } from './session';

const agent = (data: Partial<GraphNode['data']> = {}): GraphNode => ({
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'Reviewer', ...data },
});
const choices: SettingsOptions = {
  models: [{ value: 'opus', label: 'Opus', efforts: [{ value: 'low', label: 'Low' }] }],
  defaults: { model: 'opus', effort: 'low', mode: 'manual' },
};
const options = vi.fn<(cli: AdapterId) => Promise<SettingsOptions>>().mockResolvedValue(choices);

/** Echo saved graph changes as the editor does, while the sheet keeps its own role draft. */
function Editor({
  initial = agent(),
  session = NEW_SESSION,
  onRole = () => undefined,
  onRestart = () => undefined,
  onFresh = () => undefined,
  onClose = () => undefined,
}: {
  initial?: GraphNode;
  session?: Session;
  onRole?: (role: string | undefined) => void;
  onRestart?: () => void;
  onFresh?: () => void;
  onClose?: () => void;
}) {
  const [node, setNode] = useState(initial);
  const [open, setOpen] = useState(false);
  const changeRole = (role: string | undefined) => {
    onRole(role);
    setNode(
      (current) => setRole({ nodes: [current], edges: [] }, current.id, role).nodes[0] ?? current,
    );
  };
  const changeAgent = (next: AdapterId, connection: AgentConnection) => {
    setNode(
      (current) =>
        setConnection(
          setAgent({ nodes: [current], edges: [] }, current.id, next),
          current.id,
          connection,
        ).nodes[0] ?? current,
    );
  };
  const changeSettings = (cli: AdapterId, settings: AgentSettings) => {
    setNode((current) => ({
      ...current,
      data: { ...current.data, settings: { ...current.data.settings, [cli]: settings } },
    }));
  };
  return (
    <>
      <AgentSettingsSummary
        node={node}
        options={options}
        onOpen={() => {
          setOpen(true);
        }}
      />
      {open && (
        <AgentSettingsPanel
          node={node}
          session={session}
          options={options}
          onRename={(label) => {
            setNode((current) => ({ ...current, data: { ...current.data, label } }));
          }}
          onRole={changeRole}
          onAgent={changeAgent}
          onSettings={changeSettings}
          onRestart={onRestart}
          onFresh={onFresh}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

const focus = (element: HTMLElement) => {
  act(() => {
    element.focus();
  });
};
const open = () => {
  const opener = screen.getByRole('button', { name: 'Agent settings: Reviewer' });
  focus(opener);
  fireEvent.click(opener);
  return {
    opener,
    panel: within(screen.getByRole('dialog', { name: 'Agent settings: Reviewer' })),
  };
};

describe('shared agent settings', () => {
  it('retains spaces in a focused local role draft while saving normalized standing instructions', () => {
    const onRole = vi.fn();
    render(<Editor onRole={onRole} />);
    const { panel } = open();
    const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
    focus(role);
    for (const draft of [' ', '  Review ', '  Review  changes\n\tCheck results.  ']) {
      fireEvent.change(role, { target: { value: draft } });
      expect(role.value).toBe(draft);
      expect(onRole).toHaveBeenLastCalledWith(draft.trim() || undefined);
    }
    // A saved-value rerender must not erase spaces still being typed. Blur adopts the saved value.
    focus(panel.getByRole('textbox', { name: 'Name' }));
    expect(role.value).toBe('Review  changes\n\tCheck results.');
    expect(screen.getByRole('button', { name: 'Agent settings: Reviewer' }).textContent).toContain(
      'Review  changes',
    );
  });

  it('clears a role with whitespace without leaving a saved empty role', () => {
    const onRole = vi.fn();
    render(<Editor initial={agent({ role: 'Review releases.' })} onRole={onRole} />);
    const { panel } = open();
    const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
    focus(role);
    fireEvent.change(role, { target: { value: ' \n\t ' } });
    expect(onRole).toHaveBeenLastCalledWith(undefined);
    expect(role.value).toBe(' \n\t ');
    focus(panel.getByRole('textbox', { name: 'Name' }));
    expect(role.value).toBe('');
    expect(screen.getByRole('button', { name: 'Agent settings: Reviewer' }).textContent).toContain(
      'No role',
    );
  });

  it('shows invalid pasted instructions and keeps the last valid saved role until corrected', () => {
    const onRole = vi.fn();
    render(<Editor initial={agent({ role: 'Review releases.' })} onRole={onRole} />);
    const { panel } = open();
    const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
    expect(role.maxLength).toBe(MAX_ROLE_LENGTH);
    focus(role);
    fireEvent.change(role, { target: { value: 'Review\u0000releases' } });
    expect(role.getAttribute('aria-invalid')).toBe('true');
    expect(panel.getByRole('alert').textContent).toContain('control characters');
    expect(onRole).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Agent settings: Reviewer' }).textContent).toContain(
      'Review releases.',
    );
    fireEvent.change(role, { target: { value: 'Review safely.' } });
    expect(role.getAttribute('aria-invalid')).toBe('false');
    expect(panel.queryByRole('alert')).toBeNull();
    expect(onRole).toHaveBeenLastCalledWith('Review safely.');
  });

  it.each(['working', 'waiting'] as const)(
    'saves role edits while %s without restarting the active session',
    async (status) => {
      const onRestart = vi.fn();
      const onRole = vi.fn();
      render(
        <Editor
          initial={agent({ connection: 'claude-code.sdk', role: 'Original role' })}
          session={{ ...NEW_SESSION, status, running: { role: 'Original role' } }}
          onRole={onRole}
          onRestart={onRestart}
        />,
      );
      const { panel } = open();
      await waitFor(() => {
        expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
      });
      expect(panel.queryByRole('status')).toBeNull();
      const role = panel.getByRole('textbox', { name: 'Role' });
      focus(role);
      fireEvent.change(role, { target: { value: 'Revised role' } });
      expect(onRole).toHaveBeenLastCalledWith('Revised role');
      expect(panel.getByRole('status').textContent).toContain('Changes saved.');
      const restart = panel.getByRole<HTMLButtonElement>('button', { name: 'Restart with these' });
      expect(restart.disabled).toBe(true);
      fireEvent.click(restart);
      expect(onRestart).not.toHaveBeenCalled();
      // Returning the authored role to what this session runs removes the pending restart.
      fireEvent.change(role, { target: { value: 'Original role' } });
      expect(panel.queryByRole('status')).toBeNull();
    },
  );

  it('offers an explicit restart once idle, including when an existing role was cleared', async () => {
    const onRestart = vi.fn();
    const initial = agent({ connection: 'claude-code.sdk', role: 'Original role' });
    const working: Session = {
      ...NEW_SESSION,
      status: 'working',
      running: { role: 'Original role' },
    };
    const rendered = render(<Editor initial={initial} session={working} onRestart={onRestart} />);
    const { panel } = open();
    await waitFor(() => {
      expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
    });
    fireEvent.change(panel.getByRole('textbox', { name: 'Role' }), { target: { value: '' } });
    expect(
      panel.getByRole<HTMLButtonElement>('button', { name: 'Restart with these' }).disabled,
    ).toBe(true);
    rendered.rerender(
      <Editor initial={initial} session={{ ...working, status: 'idle' }} onRestart={onRestart} />,
    );
    const restart = panel.getByRole<HTMLButtonElement>('button', { name: 'Restart with these' });
    expect(restart.disabled).toBe(false);
    expect(onRestart).not.toHaveBeenCalled();
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledOnce();
    expect(panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' }).value).toBe('');
  });

  it.each(['codex.app-server', 'codex.terminal'] as const)(
    'applies a changed Codex role through an explicit new %s conversation, available once idle',
    async (connection) => {
      const onRestart = vi.fn();
      const onFresh = vi.fn();
      const initial = agent({ adapter: 'codex', connection, role: 'Original role' });
      const working: Session = {
        ...NEW_SESSION,
        status: 'working',
        running: { role: 'Original role' },
      };
      const rendered = render(
        <Editor initial={initial} session={working} onRestart={onRestart} onFresh={onFresh} />,
      );
      const { panel } = open();
      await waitFor(() => {
        expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
      });
      fireEvent.change(panel.getByRole('textbox', { name: 'Role' }), {
        target: { value: 'Revised role' },
      });
      expect(panel.queryByRole('button', { name: 'Restart with these' })).toBeNull();
      expect(panel.getByText(/Codex keeps a conversation’s original role/).textContent).toContain(
        'earlier conversation stays in Codex’s history',
      );
      const fresh = panel.getByRole<HTMLButtonElement>('button', {
        name: 'Start new conversation with this role',
      });
      expect(fresh.disabled).toBe(true);
      fireEvent.click(fresh);
      expect(onFresh).not.toHaveBeenCalled();
      rendered.rerender(
        <Editor
          initial={initial}
          session={{ ...working, status: 'idle' }}
          onRestart={onRestart}
          onFresh={onFresh}
        />,
      );
      expect(fresh.disabled).toBe(false);
      fireEvent.click(fresh);
      expect(onFresh).toHaveBeenCalledOnce();
      expect(onRestart).not.toHaveBeenCalled();
    },
  );

  it('offers a new Codex conversation even before its remembered session has been opened', async () => {
    const onFresh = vi.fn();
    render(
      <Editor
        initial={agent({ adapter: 'codex', connection: 'codex.app-server', role: 'Saved role' })}
        onFresh={onFresh}
      />,
    );
    const { panel } = open();
    await waitFor(() => {
      expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
    });
    fireEvent.click(panel.getByRole('button', { name: 'Start new conversation with this role' }));
    expect(onFresh).toHaveBeenCalledOnce();
    expect(panel.queryByRole('button', { name: 'Restart with these' })).toBeNull();
  });

  it('focuses the name, traps Tab within the sheet, and returns focus on Escape without bubbling', () => {
    const onClose = vi.fn();
    const outsideEscape = vi.fn();
    render(
      <div onKeyDown={outsideEscape}>
        <Editor onClose={onClose} />
      </div>,
    );
    const { opener, panel } = open();
    expect(document.activeElement).toBe(panel.getByRole('textbox', { name: 'Name' }));
    const last = panel.getByRole('button', { name: /^Mode:/ });
    const close = panel.getByRole('button', { name: 'Close agent settings' });
    focus(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    outsideEscape.mockClear();
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(outsideEscape).not.toHaveBeenCalled();
  });

  it('closes an inner choice with Escape before closing the settings sheet', async () => {
    const onClose = vi.fn();
    render(<Editor initial={agent({ connection: 'claude-code.sdk' })} onClose={onClose} />);
    const { panel } = open();
    await waitFor(() => {
      expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
    });
    const model = panel.getByRole('button', { name: 'Model: Default (Opus)' });
    fireEvent.click(model);
    expect(panel.getByRole('menu', { name: 'Model' })).toBeTruthy();
    fireEvent.keyDown(model, { key: 'Escape' });
    expect(panel.queryByRole('menu', { name: 'Model' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(model, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('still owns Escape when choosing a model removes the focused menu item', async () => {
    const onClose = vi.fn();
    render(<Editor initial={agent({ connection: 'claude-code.sdk' })} onClose={onClose} />);
    const { opener, panel } = open();
    await waitFor(() => {
      expect(panel.getByRole('button', { name: 'Model: Default (Opus)' })).toBeTruthy();
    });
    fireEvent.click(panel.getByRole('button', { name: 'Model: Default (Opus)' }));
    const choice = panel.getByRole('menuitemradio', { name: 'Opus' });
    focus(choice);
    fireEvent.click(choice);
    expect(document.activeElement).toBe(panel.getByRole('button', { name: 'Model: Opus' }));
    // Escape also belongs to the sheet if native focus has returned to the document body.
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
