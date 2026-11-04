import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FilesRewind, RewindRestore } from '../../shared/session';
import { events } from '../test-render';
import { Rewind } from './Rewind';

/*
 * What a rewind panel offers is what its session's `restores` allow, whatever else the provider
 * could do: each subset shows its own buttons and words.
 */

const POINTS = [
  { id: 'm1', text: 'First' },
  { id: 'm2', text: 'Second' },
];
const CHANGED: FilesRewind = { possible: true, files: ['src/cart.ts'], added: 4, removed: 10 };

function shown(restores: readonly RewindRestore[], files: FilesRewind = CHANGED) {
  const preview = vi.fn<(id: string) => Promise<FilesRewind>>().mockResolvedValue(files);
  const rewind = vi.fn().mockResolvedValue({ conversation: true });
  render(
    <Rewind
      messages={POINTS}
      restores={restores}
      start="m2"
      preview={preview}
      rewind={rewind}
      onRewound={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { preview, rewind };
}
const buttons = async () => {
  // Let the preview, where there is one, settle.
  await screen.findByRole('group', { name: 'Rewind' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return within(screen.getByRole('group', { name: 'Rewind' }))
    .getAllByRole('button')
    .map((button) => button.textContent);
};
const panel = () => within(screen.getByRole('group', { name: 'Rewind' }));

describe('the rewind panel’s restores', () => {
  it('offers the conversation alone without a files preview or any word about code', async () => {
    const { preview } = shown(['conversation']);
    expect(await buttons()).toEqual(['Restore conversation', 'Cancel']);
    expect(preview).not.toHaveBeenCalled();
    expect(panel().getByText(/^Drops this message and what followed/)).toBeTruthy();
    expect(panel().queryByText(/files|Restores|code/i)).toBeNull();
  });

  it('offers the code alone after a successful preview, without the dropped-conversation sentence', async () => {
    const { preview } = shown(['code']);
    expect(await buttons()).toEqual(['Restore code', 'Cancel']);
    expect(preview).toHaveBeenCalledExactlyOnceWith('m2');
    expect(panel().getByText('Restores src/cart.ts (+4 −10).')).toBeTruthy();
    expect(panel().queryByText(/Drops this message/)).toBeNull();
  });

  it('offers no code restore where the files can’t be restored, and says why', async () => {
    shown(['code', 'both'], {
      possible: false,
      files: [],
      added: 0,
      removed: 0,
      error: 'No checkpoint',
    });
    expect(await buttons()).toEqual(['Cancel']);
    expect(panel().getByText('Its files can’t be restored: No checkpoint.')).toBeTruthy();
    expect(panel().queryByText(/Drops this message/)).toBeNull();
  });

  it('offers no code restore where no file changed, but the conversation if declared', async () => {
    shown(['both', 'conversation', 'code'], { possible: true, files: [], added: 0, removed: 0 });
    expect(await buttons()).toEqual(['Restore conversation', 'Cancel']);
    expect(panel().getByText('No files changed since then.')).toBeTruthy();
  });

  it('offers each declared kind in order, the code ones after the preview', async () => {
    shown(['code', 'both']);
    expect(await buttons()).toEqual(['Restore code and conversation', 'Restore code', 'Cancel']);
    expect(panel().getByText(/^Drops this message/)).toBeTruthy();
  });

  it('rewinds with the kind clicked, once', async () => {
    const { rewind } = shown(['conversation', 'code']);
    await buttons();
    await events.click(panel().getByRole('button', { name: 'Restore code' }));
    expect(rewind).toHaveBeenCalledExactlyOnceWith('m2', 'code');
  });
});
