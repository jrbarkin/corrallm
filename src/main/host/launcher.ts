import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * The packaged app's own `corrallm` launcher (B30 C2), for HostServices.launcher: `bin/corrallm`
 * in its resources, as a real path, only when that is a regular file, only on macOS and Linux, and
 * never when macOS runs the app from a translocated copy (a link to it would break at the next
 * launch). It is found from the packaged app itself: nothing a window, an operation, a setting or
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
    if (real.split(path.sep).includes('AppTranslocation')) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
