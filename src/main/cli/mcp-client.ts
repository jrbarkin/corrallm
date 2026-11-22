import { request } from 'node:http';
import path from 'node:path';
import { TOKEN_REPLACED, TOO_MANY_WAITS } from '../../shared/api/errors';
import type { OpError } from '../../shared/api/errors';
import { toolName } from '../../shared/api/registry';
import type { OpName } from '../../shared/api/surface';
import { appProfile } from '../core/host/node';
import { readApiFile } from '../core/api-file';
import { loopbackUrl } from '../url-policy';
import { readTokenFile } from './token-file';

export const TOKEN_VARIABLE = 'CORRALLM_OUTSIDE_TOKEN';
export const TOKEN_FILE_VARIABLE = 'CORRALLM_OUTSIDE_TOKEN_FILE';
export const URL_VARIABLE = 'CORRALLM_URL';
export const WAIT_SLACK_MS = 30_000;

/** The same failures and exit codes as wait, without credentials in the diagnostic. */
export class CliFailure extends Error {
  readonly exitCode: number;
  readonly error: OpError;
  constructor(exitCode: number, error: OpError) {
    super(error.sentence);
    this.exitCode = exitCode;
    this.error = error;
  }
}
export function cliFailure(error: unknown): CliFailure {
  return error instanceof CliFailure
    ? error
    : new CliFailure(5, { code: 'unavailable', sentence: 'The command could not complete.' });
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CliFailure(3, { code: 'unavailable', sentence: 'The server gave no result object.' });
  return value as Record<string, unknown>;
}
export interface McpClient {
  call: (
    op: OpName,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
}
interface HttpAnswer {
  status: number;
  body: string;
  type: string;
}

/** Every call rereads its private credential, so rotation needs no client restart. */
export function mcpClient({
  env,
  tokenFile,
  cwd = process.cwd(),
  allowEnvironmentToken = false,
  post: send = post,
  discover = () => readApiFile(appProfile({ env })).then((file) => file?.url),
}: {
  env: NodeJS.ProcessEnv;
  tokenFile?: string;
  cwd?: string;
  allowEnvironmentToken?: boolean;
  post?: typeof post;
  discover?: () => Promise<string | undefined>;
}): McpClient {
  return {
    call: async (op, args, timeoutMs = 60_000) => {
      if (!allowEnvironmentToken && env.CORRALLM_AGENT_SESSION === '1')
        throw new CliFailure(2, {
          code: 'refused',
          sentence:
            'Outside credentials are not used inside a corrallm agent session. Use its own corrallm tools.',
        });
      let token =
        tokenFile === undefined && allowEnvironmentToken ? env[TOKEN_VARIABLE] : undefined;
      const file = tokenFile ?? env[TOKEN_FILE_VARIABLE];
      if (!token && file) {
        try {
          token = await readTokenFile(path.resolve(cwd, file));
        } catch (error) {
          throw new CliFailure(2, {
            code: 'refused',
            sentence: `${TOKEN_FILE_VARIABLE} names no token to send: ${error instanceof Error ? error.message : 'the file could not be read'}`,
          });
        }
      }
      if (!token)
        throw new CliFailure(2, {
          code: 'refused',
          sentence: allowEnvironmentToken
            ? `Set ${TOKEN_VARIABLE} or ${TOKEN_FILE_VARIABLE} to a token corrallm made.`
            : `Set ${TOKEN_FILE_VARIABLE}, or use --token-file, to name the private token file corrallm wrote.`,
        });
      const given = env[URL_VARIABLE];
      const found = given === undefined || given === '' ? await discover() : given;
      if (found === undefined)
        throw new CliFailure(3, {
          code: 'unavailable',
          sentence: `No corrallm server runs on the app’s profile: start corrallm serve, or set ${URL_VARIABLE} to the URL it printed.`,
        });
      const url = loopbackUrl(found);
      if (url === null)
        throw new CliFailure(3, {
          code: 'unavailable',
          sentence: `${URL_VARIABLE} (or api.json) names no corrallm server on this machine: its token goes only to http://127.0.0.1:<port>/mcp (or localhost), with no name, password or query.`,
        });
      let answer: HttpAnswer;
      try {
        answer = await send(
          url,
          token,
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: toolName(op), arguments: args },
          }),
          timeoutMs,
        );
      } catch {
        throw new CliFailure(3, {
          code: 'unavailable',
          sentence: `No corrallm server answered at ${url}.`,
        });
      }
      const reply = rpcReply(answer);
      if (answer.status === 401 || answer.status === 403)
        throw new CliFailure(2, {
          code: 'refused',
          sentence:
            answer.status === 403
              ? 'The server refused the request.'
              : reply?.error?.message === TOKEN_REPLACED
                ? TOKEN_REPLACED
                : 'The server refused the token: it is wrong, or it expired or was replaced.',
        });
      if (answer.status >= 500 || reply === undefined)
        throw new CliFailure(3, {
          code: 'unavailable',
          sentence: `The server at ${url} answered ${String(answer.status)}, not a result.`,
        });
      if (reply.error !== undefined)
        throw new CliFailure(5, { code: 'invalid', sentence: reply.error.message });
      if (reply.result?.isError === true) {
        const error = (
          parseJson(reply.result.content?.[1]?.text) as { error?: OpError } | undefined
        )?.error ?? { code: 'refused', sentence: 'The operation was refused.' };
        throw new CliFailure(
          error.code === 'refused' && error.sentence === TOKEN_REPLACED
            ? 2
            : error.code === 'unavailable' || error.sentence === TOO_MANY_WAITS
              ? 3
              : 5,
          error,
        );
      }
      return object(reply.result?.structuredContent);
    },
  };
}

interface RpcReply {
  error?: { message: string };
  result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown };
}
function rpcReply({ body, type }: HttpAnswer): RpcReply | undefined {
  if (type.startsWith('application/json')) return envelope(parseJson(body));
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const value = parseJson(line.slice(5).trim());
    if (typeof value === 'object' && value !== null && 'id' in value && value.id === 1)
      return envelope(value);
  }
  return undefined;
}
function envelope(value: unknown): RpcReply | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Record<string, unknown>;
  const error = parsed.error;
  if (
    error !== undefined &&
    (typeof error !== 'object' ||
      error === null ||
      !('message' in error) ||
      typeof error.message !== 'string')
  )
    return undefined;
  if (
    parsed.result !== undefined &&
    (typeof parsed.result !== 'object' || parsed.result === null || Array.isArray(parsed.result))
  )
    return undefined;
  return value;
}
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Bounded response and a whole-request deadline, including interrupted response streams. */
function post(url: string, token: string, body: string, ms: number): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      clearTimeout(timer);
      sent.destroy();
      reject(error);
    };
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
      (response) => {
        let text = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 40 * 1024 * 1024) failed(new Error('The response was too large.'));
          else text += chunk;
        });
        response.once('end', () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            body: text,
            type: response.headers['content-type'] ?? '',
          });
        });
        response.once('error', failed);
        response.once('aborted', () => {
          failed(new Error('The response was interrupted.'));
        });
      },
    );
    const timer = setTimeout(() => {
      failed(new Error('The server took too long.'));
    }, ms);
    sent.once('error', failed);
    sent.end(body);
  });
}
