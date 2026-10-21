import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterId } from '../../shared/adapter';
import { MAX_LABEL } from '../../shared/api/limits';
import { MAX_ROLE_LENGTH } from '../../shared/session';
import type { AgentSettings, SettingsOptions } from '../../shared/session';
import type { AgentConnection } from '../graph/agents';
import * as AgentOps from '../../shared/model/agent-ops';
import { catalog } from '../catalog';
import { DEFAULT_AGENT } from '../graph/agents';
import type { CanvasId } from '../../shared/canvas';
import type { AgentNode } from '../../shared/model/canvas';
import { AgentSettingsPanel, AgentSettingsSummary } from './AgentSettings';
import { SettingsMenu } from './Settings';
import { NEW_SESSION } from '../../shared/model/session';
import type { Session } from '../../shared/model/session';

afterEach(() => {
  vi.useRealTimers();
});

const agent = (data: Partial<AgentNode['data']> = {}): AgentNode => ({
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
  initial?: AgentNode;
  session?: Session;
  onRole?: (role: string | undefined) => void;
  onRestart?: () => void;
  onFresh?: () => void;
  onClose?: () => void;
}) {
  const asDoc = (node: AgentNode) => ({
    id: '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b' as CanvasId,
    arrange: false,
    nodes: [node],
    links: [],
  });
  const [node, setNode] = useState(initial);
  const [open, setOpen] = useState(false);
  const changeRole = (role: string | undefined) => {
    onRole(role);
    setNode(
      (current) =>
        (AgentOps.setRole(asDoc(current), { agent: current.id, role }).next.nodes[0] as
          AgentNode | undefined) ?? current,
    );
  };
  const changeAgent = (next: AdapterId, connection: AgentConnection) => {
    const context = { catalog: catalog(), defaultAdapter: DEFAULT_AGENT };
    setNode((current) => {
      const typed = AgentOps.setType(asDoc(current), { agent: current.id, adapter: next }, context);
      const connected = AgentOps.setConnection(
        typed.next,
        { agent: current.id, connection },
        context,
      );
      return (connected.next.nodes[0] as AgentNode | undefined) ?? current;
    });
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
  it('shows the adapter’s own effort labels in the settings sheet', async () => {
    const supplied = (): Promise<SettingsOptions> =>
      Promise.resolve({
        models: [
          { value: 'test', label: 'Test', efforts: [{ value: 'high', label: 'Careful work' }] },
        ],
        defaults: { model: 'test', effort: 'high', mode: null },
      });
    render(
      <SettingsMenu
        inline
        adapter="claude-code"
        connection="claude-code.sdk"
        settings={{}}
        options={supplied}
        running={undefined}
        working={false}
      />,
    );
    const effort = await screen.findByRole('button', { name: 'Effort: Default (Careful work)' });
    fireEvent.click(effort);
    expect(screen.getByRole('menuitemradio', { name: 'Careful work' })).toBeTruthy();
  });
  it('shows the selected adapter’s logo in the CLI choice', () => {
    render(<Editor />);
    const { panel } = open();
    const choice = panel.getByRole('button', { name: /^Agent:/ });
    expect(within(choice).getByRole('img', { name: 'Claude Code' }).tagName).toBe('IMG');
  });

  it('drafts the name until Enter and cancels a role draft with Escape without closing the sheet', () => {
    const onRole = vi.fn();
    const onClose = vi.fn();
    render(<Editor onRole={onRole} onClose={onClose} />);
    const { panel } = open();
    const name = panel.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Builder' } });
    expect(screen.getByRole('dialog', { name: 'Agent settings: Reviewer' })).toBeTruthy();
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Agent settings: Builder' })).toBeTruthy();
    const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
    focus(role);
    fireEvent.change(role, { target: { value: 'Uncommitted role' } });
    fireEvent.keyDown(role, { key: 'Escape' });
    expect(role.value).toBe('');
    expect(onRole).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'blur', 'idle'] as const)(
    'restores a blank name on %s and bounds names',
    (how) => {
      vi.useFakeTimers();
      try {
        render(<Editor />);
        const { panel } = open();
        const name = panel.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
        expect(name.maxLength).toBe(MAX_LABEL);
        for (const draft of ['   ', `${' '.repeat(MAX_LABEL)}x`]) {
          focus(name);
          fireEvent.change(name, { target: { value: draft } });
          if (how === 'Enter') fireEvent.keyDown(name, { key: 'Enter' });
          else if (how === 'blur') fireEvent.blur(name);
          else
            act(() => {
              vi.advanceTimersByTime(600);
            });
          expect(name.value).toBe('Reviewer');
        }
        fireEvent.change(name, { target: { value: 'x'.repeat(MAX_LABEL + 1) } });
        fireEvent.blur(name);
        expect(name.value).toBe('x'.repeat(MAX_LABEL));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('retains spaces in a focused local role draft and saves normalized instructions on leave', () => {
    const onRole = vi.fn();
    render(<Editor onRole={onRole} />);
    const { panel } = open();
    const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
    focus(role);
    for (const draft of [' ', '  Review ', '  Review  changes\n\tCheck results.  ']) {
      fireEvent.change(role, { target: { value: draft } });
      expect(role.value).toBe(draft);
      expect(onRole).not.toHaveBeenCalled();
    }
    // A saved-value rerender must not erase spaces still being typed. Blur adopts the saved value.
    focus(panel.getByRole('textbox', { name: 'Name' }));
    expect(onRole).toHaveBeenCalledExactlyOnceWith('Review  changes\n\tCheck results.');
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
    expect(onRole).not.toHaveBeenCalled();
    expect(role.value).toBe(' \n\t ');
    focus(panel.getByRole('textbox', { name: 'Name' }));
    expect(onRole).toHaveBeenCalledExactlyOnceWith(undefined);
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
    expect(onRole).not.toHaveBeenCalled();
    fireEvent.blur(role);
    expect(onRole).toHaveBeenLastCalledWith('Review safely.');
  });

  it.each(['blur', 'idle'] as const)(
    'retains an invalid role and its error after %s until Escape',
    (how) => {
      vi.useFakeTimers();
      const onRole = vi.fn();
      render(<Editor initial={agent({ role: 'Saved role' })} onRole={onRole} />);
      const { panel } = open();
      const role = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Role' });
      focus(role);
      fireEvent.change(role, { target: { value: 'Keep\u0000this draft' } });
      if (how === 'idle')
        act(() => {
          vi.advanceTimersByTime(600);
        });
      focus(panel.getByRole('textbox', { name: 'Name' }));
      expect(role.value).toBe('Keep\u0000this draft');
      expect(panel.getByRole('alert').textContent).toContain('control characters');
      expect(onRole).not.toHaveBeenCalled();
      focus(role);
      expect(role.value).toBe('Keep\u0000this draft');
      fireEvent.keyDown(role, { key: 'Escape' });
      expect(role.value).toBe('Saved role');
      expect(panel.queryByRole('alert')).toBeNull();
      vi.useRealTimers();
    },
  );

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
      expect(onRole).not.toHaveBeenCalled();
      fireEvent.blur(role);
      expect(onRole).toHaveBeenLastCalledWith('Revised role');
      expect(panel.getByRole('status').textContent).toContain('Changes saved.');
      const restart = panel.getByRole<HTMLButtonElement>('button', { name: 'Restart with these' });
      expect(restart.disabled).toBe(true);
      fireEvent.click(restart);
      expect(onRestart).not.toHaveBeenCalled();
      // Returning the authored role to what this session runs removes the pending restart.
      fireEvent.change(role, { target: { value: 'Original role' } });
      fireEvent.blur(role);
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
    fireEvent.blur(panel.getByRole('textbox', { name: 'Role' }));
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

  it.each(['toString', 'constructor'])(
    'names an agent whose adapter is named like what every object inherits (%s) by its id',
    (adapter) => {
      render(<Editor initial={agent({ adapter, connection: adapter })} />);
      expect(
        screen.getByRole('button', { name: 'Agent settings: Reviewer' }).textContent,
      ).toContain(`${adapter} · Not connected`);
      const { panel } = open();
      expect(panel.getByRole('button', { name: `Agent: ${adapter} · Not connected` })).toBeTruthy();
    },
  );

  it.each(['toString', 'constructor'])(
    'words the settings of an adapter it has no words for (%s) as any CLI’s',
    (adapter) => {
      render(
        <SettingsMenu
          inline
          adapter={adapter}
          connection={adapter}
          settings={{}}
          options={options}
          running={undefined}
          working={false}
        />,
      );
      expect(screen.getByRole('group', { name: 'Its CLI settings' })).toBeTruthy();
    },
  );
});
