import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { TopicStates } from '../../shared/api/topics';
import { expectOneOp, fakeCore } from '../test-api';
import { events, renderReady } from '../test-render';
import { SettingsPage } from './SettingsPage';

/*
 * The Settings section for the `corrallm` command (B30 C2): its words come from the status alone,
 * Install and Remove are each one operation, and no field takes a path or text.
 */

afterEach(cleanup);

type Command = NonNullable<TopicStates['settings']['command']>;
type Is = 'absent' | 'current' | 'stale' | 'taken';

const AT = '~/.local/bin/corrallm';
const ready = (
  is: Is,
  over: { onPath?: boolean; runs?: { at: string; current: boolean } | null } = {},
): Command => ({
  state: 'ready',
  link: { at: AT, is, onPath: over.onPath ?? true },
  runs: over.runs ?? null,
});

/** The settings page for a status (or a core that sends none), and its command section. */
async function open(command: Command | undefined) {
  const core = fakeCore();
  const previous = core.state('settings');
  if (!previous) throw new Error('No settings fixture');
  const rest = { ...previous.state };
  delete rest.command;
  core.snapshot('settings', command === undefined ? rest : { ...rest, command });
  await renderReady(
    <SettingsPage client={core.api} mirror={core.topics} onClose={() => undefined} />,
  );
  const heading = screen.getByRole('heading', { name: 'The corrallm command' });
  const section = heading.closest('section');
  if (section === null) throw new Error('No command section');
  return { core, section: within(section) };
}

const INSTALL = { name: 'Install the corrallm command' };
const REMOVE = { name: 'Remove the corrallm command' };
const OURS = { at: AT, current: true };

it.each<[string, Command, (string | RegExp)[], boolean, boolean]>([
  ['not installed', ready('absent'), ['Not installed'], true, false],
  [
    'installed',
    ready('current', { runs: OURS }),
    [`Installed: \`corrallm\` runs this app (${AT})`],
    false,
    true,
  ],
  [
    'linked to another copy',
    ready('stale'),
    [`${AT} links to another copy of corrallm`],
    true,
    true,
  ],
  [
    'taken by something else',
    ready('taken'),
    [`Something else is at ${AT}; corrallm leaves it alone`],
    false,
    false,
  ],
  [
    'installed by a package',
    ready('absent', { runs: { at: '/usr/bin/corrallm', current: true } }),
    ['Installed: `corrallm` runs this app (/usr/bin/corrallm)'],
    false,
    false,
  ],
  [
    'installed off the PATH',
    ready('current', { onPath: false }),
    [
      `Installed at ${AT}`,
      /~\/\.local\/bin isn’t on your shell’s PATH: add `export PATH="\$HOME\/\.local\/bin:\$PATH"` to your shell’s startup file/,
    ],
    false,
    true,
  ],
  [
    'shadowed by another program',
    ready('current', { runs: { at: '/opt/x/corrallm', current: false } }),
    [`Installed at ${AT}`, '`corrallm` in your shell runs another program (/opt/x/corrallm)'],
    false,
    true,
  ],
  [
    'unavailable',
    { state: 'unavailable', sentence: 'Move corrallm to Applications, then open it from there.' },
    ['Move corrallm to Applications, then open it from there.'],
    false,
    false,
  ],
])(
  'says the command is %s in words from its status, offering only what applies',
  async (_name, command, lines, install, remove) => {
    const { core, section } = await open(command);
    try {
      for (const line of lines) expect(section.getByText(line)).toBeTruthy();
      expect(section.queryByRole('button', INSTALL) !== null).toBe(install);
      expect(section.queryByRole('button', REMOVE) !== null).toBe(remove);
      // No field takes a path or text, and reading sends nothing.
      expect(section.queryAllByRole('textbox')).toEqual([]);
      expect(core.operations).toEqual([]);
    } finally {
      core.dispose();
    }
  },
);

it('installs with one operation', async () => {
  const { core, section } = await open(ready('absent'));
  try {
    await events.click(section.getByRole('button', INSTALL));
    await waitFor(() => {
      expectOneOp(core, 'app.command', { action: 'install' });
    });
  } finally {
    core.dispose();
  }
});

it('removes with one operation', async () => {
  const { core, section } = await open(ready('current'));
  try {
    await events.click(section.getByRole('button', REMOVE));
    await waitFor(() => {
      expectOneOp(core, 'app.command', { action: 'remove' });
    });
  } finally {
    core.dispose();
  }
});

it('keeps a refusal at the command row, and the button can try again', async () => {
  const { core, section } = await open(ready('absent'));
  const sentence =
    'corrallm couldn’t link the command: ~/.local/bin is a link, isn’t yours, or others can write to it, so link it yourself.';
  core.reply('app.command', { ok: false, error: { code: 'refused', sentence } });
  try {
    await events.click(section.getByRole('button', INSTALL));
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    expect(section.getByRole('button', INSTALL).getAttribute('aria-disabled')).toBeNull();
  } finally {
    core.dispose();
  }
});

it('says nothing of the command from a core that sends no status', async () => {
  const { core, section } = await open(undefined);
  try {
    expect(section.queryAllByRole('status')).toEqual([]);
    expect(section.queryAllByRole('button')).toEqual([]);
  } finally {
    core.dispose();
  }
});
