import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * The packaged app's own `corrallm` launcher (B30 C2), for HostServices.launcher: `bin/corrallm`
 * in its resources, as a real path, only when that is a regular file and only on macOS and Linux.
 * A translocated copy's path is handed over as it is: the core refuses to link it and says to move
 * the app to Applications (a link to it would break at the next launch). It is found from the packaged app itself: nothing a window, an operation, a setting or
 * the environment says reaches it.
 */
export function packagedLauncher({
  packaged,
  resourcesPath,
  platform = process.platform,
}: {
  packaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}): string | null {
  if (!packaged || (platform !== 'darwin' && platform !== 'linux')) return null;
  try {
    const real = realpathSync(path.join(resourcesPath, 'bin', 'corrallm'));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
