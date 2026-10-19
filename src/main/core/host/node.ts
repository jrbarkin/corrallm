import { homedir } from 'node:os';
import path from 'node:path';

import { OpFailure } from '../call';
import type { HostServices } from '../host';

/*
 * The core's host under plain Node (`corrallm serve`, Core Server §7.6). It has no desktop: no
 * dialog, so whatever needs one (choosing a file or a project folder) is yours, in the app, and it
 * mints no TrustedPath of its own; the paths the core opens and works in are those the app's
 * dialogs gave, read back from the profile. The profile is the app's own folder unless told
 * another.
 */

/** Why the host can't show a dialog: there is nobody to show it to. */
const NO_DIALOG =
  'Only you can choose a file or a folder, in corrallm’s window: corrallm serve has no window.';

const refuse = () => Promise.reject(new OpFailure('human-only', NO_DIALOG));

export const NODE_HOST: HostServices = {
  pickCanvasToOpen: refuse,
  pickCanvasToSave: refuse,
  pickFolder: refuse,
};

/**
 * The folder the app keeps its profile in (Electron's userData for corrallm): ~/Library/Application
 * Support/corrallm on macOS, %APPDATA%\corrallm on Windows, $XDG_CONFIG_HOME/corrallm (or
 * ~/.config/corrallm) elsewhere.
 */
export function appProfile({
  platform = process.platform,
  env = process.env,
  home = homedir(),
}: {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
} = {}): string {
  if (platform === 'win32') {
    const roaming = env.APPDATA;
    return path.win32.join(
      roaming !== undefined && path.win32.isAbsolute(roaming)
        ? roaming
        : path.win32.join(home, 'AppData', 'Roaming'),
      'corrallm',
    );
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'corrallm');
  }
  const config = env.XDG_CONFIG_HOME;
  return path.posix.join(
    config !== undefined && path.posix.isAbsolute(config)
      ? config
      : path.posix.join(home, '.config'),
    'corrallm',
  );
}
