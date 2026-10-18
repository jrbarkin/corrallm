import { readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * For tests: what the real Codex app server (Codex CLI 0.160.1, GPT-6-Luna) said and was told,
 * recorded in fixtures/ as one JSON-RPC message per line, both ways, with when (ms from its
 * start), in scratch folders (/work/smoke/…, home /Users/someone), the account's ids, the
 * machine's name and the user's own MCP servers (tool_repl, web_repl) replaced with stand-ins,
 * and the user's own skills left out (Codex's system skills kept). A line starting "//" says what
 * the recording is.
 *
 * - handshake: initialize, account/read (a ChatGPT login), model/list, account/rateLimits/read,
 *   collaborationMode/list, an ephemeral thread/start, fuzzyFileSearch.
 * - turns: at low effort in a read-only sandbox: `ls`, then a command it asked to run (allowed
 *   once); in workspace-write, an append; in plan mode, a plan proposed; then thread/read and
 *   account/rateLimits/read.
 * - patch, interrupt, image, resume: recorded through corrallm's own App Server session (its
 *   requests as it makes them): a patch and a command, then /diff, /status, /mcp and /skills; a
 *   command interrupted while it runs; a pasted image; the patch's thread resumed (its last turns
 *   as history), then /compact.
 * - options: config/read and model/list, asked together as corrallm asks them for an agent's
 *   settings (codex/options.ts), on a server of their own; only what corrallm reads of the
 *   config is kept.
 */

export type Fixture =
  'handshake' | 'turns' | 'patch' | 'interrupt' | 'image' | 'resume' | 'options';

/** One message: sent to the app server ('out'), from it ('in'), or its exit ('close'). */
export interface RecordedLine {
  t: number;
  dir: 'in' | 'out' | 'close';
  msg: Record<string, unknown>;
}

/** Where the first recordings worked, and the home folder, as they name them. */
export const RECORDED_PLACES = { cwd: '/work/smoke/p1', home: '/Users/someone' };

/** Where corrallm's own recordings worked: /work/smoke/<folder> (patch and resume: "one"). */
export function recordedPlaces(folder: string): { cwd: string; home: string } {
  return { cwd: `/work/smoke/${folder}`, home: '/Users/someone' };
}

const FOLDER = path.join(import.meta.dirname, 'fixtures');

export function recorded(name: Fixture): RecordedLine[] {
  return readFileSync(path.join(FOLDER, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('//'))
    .map((line) => JSON.parse(line) as RecordedLine);
}

/** The notifications the app server sent, in order: their method and params. */
export function recordedNotifications(name: Fixture): { method: string; params: unknown }[] {
  return recorded(name).flatMap(({ dir, msg }) =>
    dir === 'in' && typeof msg.method === 'string' && msg.id === undefined
      ? [{ method: msg.method, params: msg.params }]
      : [],
  );
}

/** The result of the request with `method` sent `nth` (0: the first). */
export function recordedResult(name: Fixture, method: string, nth = 0): unknown {
  const lines = recorded(name);
  const sent = lines.filter(({ dir, msg }) => dir === 'out' && msg.method === method)[nth];
  if (!sent) throw new Error(`${name} has no ${method} request #${String(nth)}`);
  const answer = lines.find(
    ({ dir, msg }) => dir === 'in' && msg.method === undefined && msg.id === sent.msg.id,
  );
  if (!answer) throw new Error(`${name} has no answer to ${method}`);
  return answer.msg.result;
}
