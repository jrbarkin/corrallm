import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { TOKEN_PATTERN } from '../core/tokens';

/*
 * A token file (Build Plan B30): where `corrallm token new|renew --into <file>` writes an outside
 * token, 0600, so a client reads the current one each time it connects (`corrallm token header`,
 * an MCP client's headers helper) or waits (`corrallm wait`, with CORRALLM_OUTSIDE_TOKEN_FILE).
 * It is read only if it is a file of the user's that no one else may read, holding one token and
 * nothing more; what is wrong with it is said without what it holds.
 */

/** The most bytes a token file holds: a token, and a line's end. */
const MOST = 1024;

/** The token in `file`: rejects, saying why without what it holds, if it isn't one to read. */
export async function readTokenFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === 'win32') {
    throw new Error('Token files on Windows need a private ACL check, which is held with Windows.');
  }
  // fstat alone is too late for a FIFO: a blocking open waits for its writer. NOFOLLOW also
  // makes replacing the last path component with a link fail in the open itself.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${file} isn’t a file.`);
    if ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()) {
      throw new Error(
        `${file} isn’t yours alone: a token belongs in a file only you can read (corrallm token renew --into it writes one).`,
      );
    }
    if (stats.size > MOST) throw new Error(`${file} holds more than a token.`);
    const bytes = Buffer.alloc(MOST + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MOST) throw new Error(`${file} holds more than a token.`);
    const token = bytes.subarray(0, size).toString('utf8').trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error(`${file} holds no corrallm token.`);
    return token;
  } finally {
    await handle.close();
  }
}
