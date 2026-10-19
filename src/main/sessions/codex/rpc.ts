import { spawn as spawnProcess } from '../process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithStdioTuple,
  StdioPipe,
} from 'node:child_process';
import { createInterface } from 'node:readline';

/*
 * `codex app-server`: Codex's own JSON-RPC interface (the one its TUI, IDE extension and desktop
 * app use), over stdio: one JSON object per line, JSON-RPC 2.0 without the "jsonrpc" field.
 * corrallm runs a private one per session, with the user's own `codex` (codex.ts), and never the
 * shared daemon a desktop app may run (`--listen` sockets are unauthenticated).
 *
 * The protocol is Codex's, and the user's version of it decides what comes over the wire: what
 * arrives is read as `unknown` and checked by whoever handles it. Requests always carry params
 * (Codex refuses one without: "missing field `params`"), and every request the server makes is
 * answered (an unanswered approval stalls the turn): by the handler, or as not handled (-32601).
 * Verified against Codex CLI 0.160.1.
 */

/** JSON-RPC's error codes, as Codex uses them. */
export const RPC_ERRORS = {
  /** An unknown method or enum value, "Not initialized", "no active turn to interrupt"… */
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** "Server overloaded; retry later." */
  overloaded: -32001,
} as const;

/** An error a JSON-RPC peer answered with (or that corrallm answers the server with). */
export class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcFailure';
    this.code = code;
    this.data = data;
  }
}

/** A request's id: echoed back exactly as it came. */
export type RequestId = string | number;

/** What the other end sends that is not an answer: notifications, and requests to answer. */
export interface RpcHandlers {
  notification?: (method: string, params: unknown) => void;
  /**
   * Answers a request the server makes: resolves with its result, or rejects (an RpcFailure).
   * `id` is the request's (the server names it again when it stops waiting for the answer).
   */
  request?: (method: string, params: unknown, id: RequestId) => Promise<unknown>;
}

/**
 * One end of a JSON-RPC conversation over lines of JSON: its requests (each resolved with its
 * result, or rejected with an RpcFailure), notifications both ways, and the other end's requests,
 * each answered once.
 */
export class JsonRpcPeer {
  readonly #write: (line: string) => void;
  readonly #handlers: RpcHandlers;
  readonly #pending = new Map<
    RequestId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 1;
  #closed: Error | undefined;

  constructor(write: (line: string) => void, handlers: RpcHandlers = {}) {
    this.#write = write;
    this.#handlers = handlers;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ method, id, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.#closed) this.#send({ method, params });
  }

  /** A line the other end wrote. */
  receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const { id, method, params, result, error } = message as Record<string, unknown>;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (typeof method === 'string') {
      if (hasId) void this.#answer(id, method, params);
      else this.#handlers.notification?.(method, params);
      return;
    }
    if (!hasId) return;
    const waiting = this.#pending.get(id);
    if (!waiting) return;
    this.#pending.delete(id);
    if (error !== undefined) waiting.reject(failure(error));
    else waiting.resolve(result);
  }

  /** The other end is gone: what waits fails with `error`, and so does what is asked from now on. */
  close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }

  async #answer(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      const handle = this.#handlers.request;
      if (!handle) {
        throw new RpcFailure(RPC_ERRORS.methodNotFound, `corrallm does not handle ${method}`);
      }
      const result = await handle(method, params, id);
      if (!this.#closed) this.#send({ id, result });
    } catch (error) {
      const { code, message } =
        error instanceof RpcFailure
          ? error
          : {
              code: RPC_ERRORS.internal,
              message: error instanceof Error ? error.message : String(error),
            };
      if (!this.#closed) this.#send({ id, error: { code, message } });
    }
  }

  #send(message: Record<string, unknown>): void {
    this.#write(`${JSON.stringify(message)}\n`);
  }
}

/** An error member of a response, as an RpcFailure. */
function failure(error: unknown): RpcFailure {
  const { code, message, data } = (
    typeof error === 'object' && error !== null ? error : {}
  ) as Record<string, unknown>;
  return new RpcFailure(
    typeof code === 'number' ? code : RPC_ERRORS.internal,
    typeof message === 'string' ? message : 'Codex’s app server failed.',
    data,
  );
}

/** Starts the app server's process: child_process.spawn, or a stand-in. */
export type SpawnAppServer = (
  codex: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>,
) => ChildProcessWithoutNullStreams;

export interface AppServerOptions {
  /** The `codex` to run (codex.ts). */
  codex: string;
  /** Where it runs: the project folder. */
  cwd: string;
  /** Its environment: the agents' (environment.ts). */
  env: Readonly<Record<string, string>>;
  /** Who it is told runs it: `name` is Codex's originator (what its threads say made them). */
  clientInfo: { name: string; title: string; version: string };
  /** More arguments after `app-server` (`-c key=value` overrides). */
  args?: readonly string[];
  onNotification?: (method: string, params: unknown) => void;
  /** Answers the server's requests (approvals, questions); unhandled ones are refused. */
  onRequest?: (method: string, params: unknown, id: RequestId) => Promise<unknown>;
  /** Starts the process (child_process.spawn; a fake in tests). */
  spawn?: SpawnAppServer;
  /** How long it may take to exit once its input ends, and again once told to stop. */
  closeMs?: number;
}

/** A running `codex app-server`, initialized. */
export interface AppServer {
  /** What it says it is ("corrallm/0.160.1 (Mac OS …)"), and its Codex's version, if it says. */
  readonly userAgent: string;
  readonly version: string | undefined;
  /** Where its Codex keeps its config, login and sessions (~/.codex). */
  readonly codexHome: string;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** Ends it (its input closes; then it is told to stop): resolves once it has exited. */
  close(): Promise<void>;
  /** Resolves when it has exited (by itself, or closed): its exit code, and what it printed last. */
  readonly exited: Promise<{ code: number | null; stderr: string }>;
}

/** The most of what it printed on stderr that is kept, for saying why it stopped. */
const STDERR_KEPT = 8192;
const CLOSE_MS = 2000;

/**
 * Starts `codex app-server` and says hello: `initialize` (with the experimental API, which plan
 * mode, permission profiles and more need), then `initialized`. Resolves once it is ready for
 * requests; rejects, with what it printed, if it stops first.
 */
export async function startAppServer({
  codex,
  cwd,
  env,
  clientInfo,
  args = [],
  onNotification,
  onRequest,
  spawn = spawnProcess,
  closeMs = CLOSE_MS,
}: AppServerOptions): Promise<AppServer> {
  const child = spawn(codex, ['app-server', ...args], {
    cwd,
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  // Always drained: a full pipe would block the server.
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
  });
  // A write after it exited (EPIPE) is heard as its exit instead.
  child.stdin.on('error', () => undefined);
  const peer = new JsonRpcPeer(
    (line) => {
      if (child.stdin.writable) child.stdin.write(line);
    },
    {
      ...(onNotification ? { notification: onNotification } : {}),
      ...(onRequest ? { request: onRequest } : {}),
    },
  );
  createInterface({ input: child.stdout }).on('line', (line) => {
    peer.receive(line);
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const stopped = (code: number | null, error?: Error) => {
      const said = stderr.trim();
      peer.close(
        new Error(
          `Codex's app server stopped${code === null ? '' : ` (exit code ${String(code)})`}` +
            (error ? `: ${error.message}` : said === '' ? '.' : `: ${said}`),
        ),
      );
      resolve({ code, stderr: said });
    };
    child.once('error', (error) => {
      stopped(null, error);
    });
    // After its output is read to the end, unlike 'exit'.
    child.once('close', (code) => {
      stopped(code);
    });
  });

  let hello: unknown;
  try {
    hello = await peer.request('initialize', {
      clientInfo,
      capabilities: { experimentalApi: true },
    });
  } catch (error) {
    // It said no (or stopped): it goes.
    child.stdin.end();
    child.kill('SIGTERM');
    throw error;
  }
  peer.notify('initialized', {});
  const userAgent = stringField(hello, 'userAgent') ?? '';
  const version = /^[^/\s]+\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent)?.[1];

  const within = (ms: number) =>
    Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(resolve, ms, false)),
    ]);
  let closing: Promise<void> | undefined;
  return {
    userAgent,
    version,
    codexHome: stringField(hello, 'codexHome') ?? '',
    request: (method, params) => peer.request(method, params),
    notify: (method, params) => {
      peer.notify(method, params);
    },
    exited,
    close: () =>
      (closing ??= (async () => {
        // Its input ending makes it exit, letting what it runs finish; SIGTERM if it lingers.
        // Never SIGKILL: that would leave the commands it runs behind.
        child.stdin.end();
        if (await within(closeMs)) return;
        child.kill('SIGTERM');
        await within(closeMs);
      })()),
  };
}

/**
 * Starts a private app server only to ask it something (`ask`), then closes it: once it runs,
 * however long it took to start (waited for if it runs already). Resolves with what `ask` resolves
 * with; rejects if the server does not start, `ask` fails, or it all takes longer than `ms`
 * (`slow` says so). Codex's Terminal connection asks this way what its TUI does not say: its
 * hooks' trust (terminal/trust.ts) and its usage limits (terminal/usage.ts).
 */
export async function askAppServer<T>(
  options: AppServerOptions,
  ask: (server: AppServer) => Promise<T>,
  {
    start = startAppServer,
    ms,
    slow,
  }: { start?: (options: AppServerOptions) => Promise<AppServer>; ms: number; slow: string },
): Promise<T> {
  const started = start(options);
  const progress = { running: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started.then((server) => {
        progress.running = true;
        return ask(server);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(slow));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const closing = started.then(
      (server) => server.close(),
      () => undefined,
    );
    if (progress.running) await closing;
  }
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[name];
  return typeof field === 'string' ? field : undefined;
}
