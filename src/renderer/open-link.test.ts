import { describe, expect, it, vi } from 'vitest';

import type { AppApi } from '../shared/ipc';
import { linkAction, openLinkWith } from './open-link';

describe('a link the user clicks', () => {
  it('opens in the browser (http, https), shows its file (file://), or does nothing', () => {
    expect(linkAction('https://docs.example.com/a')).toBe('open');
    expect(linkAction('http://localhost:3000/')).toBe('open');
    expect(linkAction('file:///work/app/notes.txt')).toBe('reveal');
    expect(linkAction('FILE:///work/app/notes.txt')).toBe('reveal');
    for (const inert of [
      'javascript:alert(1)',
      'vscode://file/work/app',
      'ssh://host',
      'notes.txt',
    ]) {
      expect(linkAction(inert)).toBeUndefined();
    }
  });

  it('goes to main: link:open for the browser, link:reveal for a file, with only the link', () => {
    const api = {
      openLink: vi.fn<AppApi['openLink']>().mockResolvedValue(true),
      revealFile: vi.fn<AppApi['revealFile']>().mockResolvedValue(false),
    };
    const open = openLinkWith(() => api);
    open('https://docs.example.com/a');
    open('file:///work/app/notes.txt');
    open('javascript:alert(1)');
    expect(api.openLink.mock.calls).toEqual([['https://docs.example.com/a']]);
    expect(api.revealFile.mock.calls).toEqual([['file:///work/app/notes.txt']]);
  });
});
