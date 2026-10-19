import { windowOf } from './window';
import type { Implementations, OpServices } from '.';

/** Clicked links, checked in the core before its host does the OS action (Core Server §4 L). */
export function linkOps({
  links,
  reveal,
  windows,
}: OpServices): Pick<Implementations, 'link.open' | 'link.reveal'> {
  return {
    'link.open': async ({ url }, ctx) => ({ opened: await links.open(windowOf(ctx), url) }),
    'link.reveal': async ({ url }, ctx) => ({
      revealed: await reveal.reveal(await windows.canvasOf(windowOf(ctx)), url),
    }),
  };
}
