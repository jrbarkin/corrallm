import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * The canonical profile used by the token control channel and the unowned writer. Checking only
 * the last folder isn't enough: another user could rename a 0700 profile in a writable ancestor
 * between the socket's check and connect/bind. Resolve aliases once, then use only this checked
 * path. Every ancestor must be controlled by this user or root. A sticky shared ancestor (such
 * as /tmp) protects its checked, user/root-owned child entry and is safe too. Same-user changes
 * and root are outside the OS-user boundary.
 */
export async function privateTokenProfile(profile: string): Promise<string> {
  if (process.platform === 'win32') {
    throw new Error('corrallm token needs an owner-only named pipe on Windows, which is held.');
  }
  const canonical = await realpath(profile);
  const uid = process.getuid?.();
  for (let at = canonical; ; at = path.dirname(at)) {
    const folder = await lstat(at);
    const own = folder.uid === uid;
    const protectedAncestor = at !== canonical && (own || folder.uid === 0);
    const writable = (folder.mode & 0o022) !== 0;
    const stickyAncestor = protectedAncestor && (folder.mode & 0o1000) !== 0;
    if (!folder.isDirectory() || !(own || protectedAncestor) || (writable && !stickyAncestor)) {
      throw new Error(
        `The profile folder or ancestor ${at} isn’t yours alone: others may replace it, so corrallm token can’t trust it. Use a profile in your own protected folder.`,
      );
    }
    if (path.dirname(at) === at) return canonical;
  }
}
