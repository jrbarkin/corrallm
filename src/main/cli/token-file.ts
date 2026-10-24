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
  const handle = await open(file, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${file} isn’t a file.`);
    if (platform !== 'win32' && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())) {
      throw new Error(
        `${file} isn’t yours alone: a token belongs in a file only you can read (corrallm token renew --into it writes one).`,
      );
    }
    if (stats.size > MOST) throw new Error(`${file} holds more than a token.`);
    const token = (await handle.readFile('utf8')).trim();
    if (!TOKEN_PATTERN.test(token)) throw new Error(`${file} holds no corrallm token.`);
    return token;
  } finally {
    await handle.close();
  }
}
