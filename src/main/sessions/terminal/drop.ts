import { stat } from 'node:fs/promises';

/*
 * Files dropped on a Terminal agent's terminal: their paths are pasted into it, quoted for a shell,
 * as a terminal pastes them (Claude Code takes an image's path as the image). The paths come from
 * the preload, which reads them from the files dropped (the page never names a path), and the IPC
 * handler checks them (args.ts: absolute, not too long, no control characters); here, only files
 * that are there are pasted.
 */

/** A path as a shell reads it: as it is when nothing in it is special to one, quoted otherwise. */
export function quotePath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // Windows paths cannot hold a double quote.
    return /^[\w@%+=:,./\\-]+$/.test(file) ? file : `"${file}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(file) ? file : `'${file.replaceAll("'", "'\\''")}'`;
}

/**
 * What dropping files pastes: the paths of those that are there, quoted, each followed by a space
 * (as macOS's Terminal pastes them). '' when none is there.
 */
export async function droppedPaste(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const there = await Promise.all(
    paths.map((file) =>
      stat(file).then(
        () => true,
        () => false,
      ),
    ),
  );
  return paths
    .filter((_file, i) => there[i])
    .map((file) => `${quotePath(file, platform)} `)
    .join('');
}
