import { createContext } from 'react';

import type { AppApi } from '../shared/ipc';

/**
 * Opens a link the user clicked (a transcript's Markdown, a terminal's links): an http(s) link in
 * their browser, a file:// link (a file Claude Code names in its terminal) by showing its file in
 * the OS file manager. The main process decides whether: it asks before opening a site, unless the
 * site is allowlisted or the user said to always open it (src/main/host/links.ts), and shows a file
 * only if it is in the canvas's project folder (src/main/host/reveal.ts). The renderer never opens a
 * link itself: in-app navigation and new windows are blocked.
 */
export type OpenLink = (url: string) => void;

/** Where clicked links go: main's link:open in the app (App.tsx); nowhere elsewhere (tests). */
export const OpenLinkContext = createContext<OpenLink>(() => undefined);

/** What clicking `url` does: open it in the browser, show its file, or nothing (undefined). */
export function linkAction(url: string): 'open' | 'reveal' | undefined {
  let protocol: string;
  try {
    ({ protocol } = new URL(url));
  } catch {
    return undefined;
  }
  if (protocol === 'http:' || protocol === 'https:') return 'open';
  return protocol === 'file:' ? 'reveal' : undefined;
}

/** Sends clicked links to main (`api`: window.api, read when one is clicked). */
export function openLinkWith(api: () => Pick<AppApi, 'openLink' | 'revealFile'>): OpenLink {
  return (url) => {
    const action = linkAction(url);
    if (action === undefined) return;
    const done = action === 'open' ? api().openLink(url) : api().revealFile(url);
    done.catch(() => undefined);
  };
}
