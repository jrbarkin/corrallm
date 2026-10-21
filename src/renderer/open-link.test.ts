import { describe, expect, it, vi } from 'vitest';

import type { GuiApi } from '../shared/gui-link';
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

  it('calls link.open for the browser and link.reveal for a file, with only the URL', () => {
    const api = {
      linkOpen: vi.fn<GuiApi['linkOpen']>().mockResolvedValue({ opened: true, revs: {} }),
      linkReveal: vi.fn<GuiApi['linkReveal']>().mockResolvedValue({ revealed: false, revs: {} }),
    };
    const open = openLinkWith(() => api);
    open('https://docs.example.com/a');
    open('file:///work/app/notes.txt');
    open('javascript:alert(1)');
    expect(api.linkOpen.mock.calls).toEqual([[{ url: 'https://docs.example.com/a' }]]);
    expect(api.linkReveal.mock.calls).toEqual([[{ url: 'file:///work/app/notes.txt' }]]);
  });
});
