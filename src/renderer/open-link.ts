import { createContext } from 'react';

/**
 * Opens a link the user clicked (a transcript's Markdown, a terminal's links) in their browser.
 * The main process decides whether: it asks first, unless the site is allowlisted or the user
 * said to always open it (src/main/links.ts). The renderer never opens a link itself: in-app
 * navigation and new windows are blocked.
 */
export type OpenLink = (url: string) => void;

/** Where clicked links go: main's link:open in the app (App.tsx); nowhere elsewhere (tests). */
export const OpenLinkContext = createContext<OpenLink>(() => undefined);
