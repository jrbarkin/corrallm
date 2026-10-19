import { createContext } from 'react';

import type { GuiApi } from '../shared/gui-link';

/**
 * Opens a link the user clicked (a transcript's Markdown, a terminal's links): an http(s) link in
 * their browser, a file:// link (a file Claude Code names in its terminal) by showing its file in
 * the OS file manager. The core decides whether: it asks before opening a site, unless the
 * site is allowlisted or the user said to always open it (src/main/links.ts), and shows a file
 * only if it is in the canvas's project folder (src/main/reveal.ts). The renderer never opens a
 * link itself: in-app navigation and new windows are blocked.
 */
export type OpenLink = (url: string) => void;

/** Where clicked links go: the core’s link.open in the app (App.tsx); nowhere elsewhere (tests). */
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

/** Sends clicked links through the typed core client, read when one is clicked. */
export function openLinkWith(api: () => Pick<GuiApi, 'linkOpen' | 'linkReveal'>): OpenLink {
  return (url) => {
    const action = linkAction(url);
    if (action === undefined) return;
    const done = action === 'open' ? api().linkOpen({ url }) : api().linkReveal({ url });
    done.catch(() => undefined);
  };
}
