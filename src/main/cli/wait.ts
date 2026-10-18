import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';

import type { OpError } from '../../shared/api/errors';
import { appProfile } from '../core/host/node';
import { readApiFile } from './api-file';
import type { WaitCommand } from './args';

/*
 * `corrallm wait` (decision 20a; API Spec §8.6): one call of the server's `wait`, on the same
 * endpoint an orchestrator's MCP client calls, for a wait longer than an MCP call may run (an
 * orchestrator's CLI may move one still running after 2 minutes to the background). The server's
 * URL comes from CORRALLM_URL, else from the app's profile's api.json while its server runs; the
 * token only from CORRALLM_OUTSIDE_TOKEN, never from the command line, which any process may read.
 * It makes one `tools/call` POST, waits a little longer than the wait, prints one JSON line (the
 * result, with `next`, or `{ error }`) and exits: 0 when something came, 1 when the time limit
 * passed, 2 when refused (no token, a wrong one, an expired one), 3 when no server answered.
 */

/** The variable an orchestrator's token is in: what it registers corrallm's MCP server with. */
export const TOKEN_VARIABLE = 'CORRALLM_OUTSIDE_TOKEN';
/** The variable that names the server's URL, for a server on another profile than the app's. */
export const URL_VARIABLE = 'CORRALLM_URL';

export const EXIT = { came: 0, timedOut: 1, refused: 2, noServer: 3 } as const;

/** How much longer than the wait itself the call may take, in ms. */
const SLACK_MS = 30 * 1000;

/** Runs `corrallm wait`, printing its one line with `print`: its exit code. */
export async function waitCommand(
  command: WaitCommand,
  { env, print }: { env: NodeJS.ProcessEnv; print: (line: string) => void },
): Promise<number> {
  const fail = (code: number, error: OpError) => {
    print(JSON.stringify({ error }));
    return code;
  };
  const token = env[TOKEN_VARIABLE];
  if (token === undefined || token === '') {
    return fail(EXIT.refused, {
      code: 'refused',
      sentence: `Set ${TOKEN_VARIABLE} to the token corrallm serve --new-token printed.`,
    });
  }
  const given = env[URL_VARIABLE];
  const url =
    given !== undefined && given !== '' ? given : (await readApiFile(appProfile({ env })))?.url;
  if (url === undefined) {
    return fail(EXIT.noServer, {
      code: 'unavailable',
      sentence: `No corrallm server runs on the app’s profile: start corrallm serve, or set ${URL_VARIABLE} to the URL it printed.`,
    });
  }
  const args = {
    timeoutSeconds: command.timeout,
    ...(command.after === undefined ? {} : { after: command.after }),
    ...(command.for === undefined ? {} : { for: command.for }),
  };
  let answer: { status: number; body: string; type: string };
  try {
    answer = await post(
      url,
      token,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait', arguments: args },
      }),
      command.timeout * 1000 + SLACK_MS,
    );
  } catch (error) {
    return fail(EXIT.noServer, {
      code: 'unavailable',
      sentence: `No corrallm server answered at ${url}: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }
  if (answer.status === 401 || answer.status === 403) {
    return fail(EXIT.refused, {
      code: 'refused',
      sentence:
        answer.status === 401
          ? `The server refused the token in ${TOKEN_VARIABLE}: it is wrong, or it expired or was replaced.`
          : 'The server refused the request.',
    });
  }
  const reply = rpcReply(answer);
  if (answer.status >= 500 || reply === undefined) {
    return fail(EXIT.noServer, {
      code: 'unavailable',
      sentence: `The server at ${url} answered ${String(answer.status)}, not a result.`,
    });
  }
  if (reply.error !== undefined) {
    return fail(EXIT.refused, { code: 'invalid', sentence: reply.error.message });
  }
  const result = reply.result;
  if (result?.isError === true) {
    const [, error] = result.content ?? [];
    const parsed = parseJson(error?.text) as { error?: OpError } | undefined;
    return fail(
      EXIT.refused,
      parsed?.error ?? { code: 'refused', sentence: 'The wait was refused.' },
    );
  }
  const value = result?.structuredContent as { messages?: unknown[]; next?: string } | undefined;
  if (!Array.isArray(value?.messages)) {
    return fail(EXIT.noServer, { code: 'unavailable', sentence: 'The server gave no messages.' });
  }
  print(JSON.stringify(value));
  return value.messages.length > 0 ? EXIT.came : EXIT.timedOut;
}

interface RpcReply {
  error?: { message: string };
  result?: {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: unknown;
  };
}

/** The JSON-RPC reply an answer holds: as JSON, or as the server-sent event that carries it. */
function rpcReply({ body, type }: { body: string; type: string }): RpcReply | undefined {
  if (type.startsWith('application/json')) return parseJson(body) as RpcReply | undefined;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const message = parseJson(line.slice('data:'.length).trim()) as
      (RpcReply & { id?: unknown }) | undefined;
    if (message?.id === 1) return message;
  }
  return undefined;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** POSTs `body` to the server, waiting up to `ms` for its whole answer. */
function post(
  url: string,
  token: string,
  body: string,
  ms: number,
): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (response: IncomingMessage) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.once('end', () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            body: text,
            type: response.headers['content-type'] ?? '',
          });
        });
        response.once('error', reject);
      },
    );
    const timer = setTimeout(() => {
      sent.destroy(new Error('it took too long to answer'));
    }, ms);
    sent.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    sent.end(body);
  });
}
