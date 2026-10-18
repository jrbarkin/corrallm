/*
 * CoreLink: typed requests and events between corrallm's processes over one port (a MessagePort,
 * a utility process's parentPort, or main's handle on that process). Either side may ask and tell:
 * main asks the core, the core asks main's HostServices, the core tells a window what changed.
 * Each request carries an id, and its answer comes back as a value, the handler's result or the
 * error it threw: a request rejects only when the other end is gone.
 *
 * What crosses must be plain data. A port's structured clone would quietly turn a class instance
 * into a plain object, dropping its prototype and private fields (only functions and symbols
 * throw), so a link checks every value before it posts it, unless its host says not to (only
 * production builds do, sparing the walk).
 */

/** What one side of a link answers and sends. */
export interface LinkContract {
  /** The requests it answers, by name: each one's arguments and result. */
  requests: Record<string, { args: unknown[]; result: unknown }>;
  /** The events it sends, by name: each one's arguments. */
  events: Record<string, unknown[]>;
}

/** A request's answer: the handler's result, or the error it threw. */
export type Answer<T> = { ok: true; value: T } | { ok: false; error: LinkError };

export interface LinkError {
  message: string;
}

/** A side's handler for each request it answers. */
export type Handlers<C extends LinkContract> = {
  [K in keyof C['requests']]: (
    ...args: C['requests'][K]['args']
  ) => C['requests'][K]['result'] | Promise<C['requests'][K]['result']>;
};

/** One end of the channel a link talks over. */
export interface LinkPort {
  post(message: unknown): void;
  /**
   * Starts delivering what the other end posts to `receive`, and calls `gone` once, saying why,
   * when the other end is gone (never, for a port that cannot outlive the other end).
   */
  start(receive: (message: unknown) => void, gone: (why: string) => void): void;
  close(): void;
}

export interface LinkOptions {
  /** Whether to check that every value it posts is plain data (default: true). */
  check?: boolean;
}

type Wire =
  | { kind: 'request'; id: number; name: string; args: unknown[] }
  | { kind: 'answer'; id: number; answer: Answer<unknown> }
  | { kind: 'event'; name: string; args: unknown[] };

interface Pending {
  resolve: (answer: Answer<unknown>) => void;
  reject: (error: Error) => void;
}

export class CoreLink<Local extends LinkContract, Remote extends LinkContract> {
  readonly #port: LinkPort;
  readonly #handlers: Handlers<Local>;
  readonly #check: boolean;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  #nextId = 1;
  /** Why the other end is gone, once it is. */
  #gone: string | undefined;

  constructor(port: LinkPort, handlers: Handlers<Local>, { check = true }: LinkOptions = {}) {
    this.#port = port;
    this.#handlers = handlers;
    this.#check = check;
    port.start(
      (message) => {
        this.#receive(message);
      },
      (why) => {
        this.#end(why);
      },
    );
  }

  /** Asks the other side: resolves with its answer; rejects only if the other end is gone. */
  request<K extends keyof Remote['requests'] & string>(
    name: K,
    ...args: Remote['requests'][K]['args']
  ): Promise<Answer<Remote['requests'][K]['result']>> {
    if (this.#gone !== undefined) return Promise.reject(new Error(this.#gone));
    const fault = this.#fault('args', args);
    if (fault) return Promise.reject(new TypeError(`Can’t send “${name}”: ${fault}.`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#port.post({ kind: 'request', id, name, args } satisfies Wire);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Tells the other side, which hears it through `on`. Dropped once the other end is gone. */
  emit<K extends keyof Local['events'] & string>(name: K, ...args: Local['events'][K]): void {
    const fault = this.#fault('args', args);
    if (fault) throw new TypeError(`Can’t send “${name}”: ${fault}.`);
    if (this.#gone === undefined) this.#port.post({ kind: 'event', name, args } satisfies Wire);
  }

  /** Listens for one of the other side's events: returns a function that stops listening. */
  on<K extends keyof Remote['events'] & string>(
    name: K,
    listener: (...args: Remote['events'][K]) => void,
  ): () => void {
    const listeners = this.#listeners.get(name) ?? new Set();
    this.#listeners.set(name, listeners);
    const heard = listener as (...args: unknown[]) => void;
    listeners.add(heard);
    return () => {
      listeners.delete(heard);
    };
  }

  /** Closes the port: what is pending rejects. */
  close(): void {
    this.#end('the link was closed');
    this.#port.close();
  }

  #receive(message: unknown): void {
    const wire = parseWire(message);
    if (!wire) return;
    switch (wire.kind) {
      case 'request':
        void this.#answer(wire.id, wire.name, wire.args);
        return;
      case 'answer': {
        const pending = this.#pending.get(wire.id);
        this.#pending.delete(wire.id);
        pending?.resolve(wire.answer);
        return;
      }
      case 'event':
        for (const listener of [...(this.#listeners.get(wire.name) ?? [])]) {
          listener(...wire.args);
        }
    }
  }

  async #answer(id: number, name: string, args: unknown[]): Promise<void> {
    let answer: Answer<unknown>;
    const handlers = this.#handlers as Record<string, (...args: unknown[]) => unknown>;
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (!handler) {
      answer = { ok: false, error: { message: `No handler for “${name}”.` } };
    } else {
      try {
        const value = await handler(...args);
        const fault = this.#fault('result', value);
        answer = fault ? { ok: false, error: { message: `The ${fault}.` } } : { ok: true, value };
      } catch (error) {
        answer = { ok: false, error: { message: messageOf(error) } };
      }
    }
    if (this.#gone !== undefined) return;
    try {
      this.#port.post({ kind: 'answer', id, answer } satisfies Wire);
    } catch (error) {
      // Not checked, and the port could not clone it (a function): the asker still hears.
      const failed: Answer<unknown> = { ok: false, error: { message: messageOf(error) } };
      this.#port.post({ kind: 'answer', id, answer: failed } satisfies Wire);
    }
  }

  #fault(root: string, value: unknown): string | undefined {
    if (!this.#check) return undefined;
    const fault = plainDataFault(value, root, new Set());
    return fault && `${fault.path} is ${fault.what}, not plain data`;
  }

  #end(why: string): void {
    if (this.#gone !== undefined) return;
    this.#gone = why;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of pending) reject(new Error(why));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message of a link's own, or undefined for anything else posted on its port. */
function parseWire(message: unknown): Wire | undefined {
  if (!isRecord(message)) return undefined;
  const { kind, id, name, args, answer } = message;
  if (
    kind === 'request' &&
    Number.isInteger(id) &&
    typeof name === 'string' &&
    Array.isArray(args)
  ) {
    return { kind, id: id as number, name, args };
  }
  if (
    kind === 'answer' &&
    Number.isInteger(id) &&
    isRecord(answer) &&
    typeof answer.ok === 'boolean'
  ) {
    return { kind, id: id as number, answer: answer as Answer<unknown> };
  }
  if (kind === 'event' && typeof name === 'string' && Array.isArray(args)) {
    return { kind, name, args };
  }
  return undefined;
}

/** The built-ins a port's structured clone keeps as they are, besides plain objects and arrays. */
const PLAIN_BUILT_INS: readonly object[] = [
  Map.prototype,
  Set.prototype,
  Date.prototype,
  Uint8Array.prototype,
];

/** Where in `value` the first thing that is not plain data is, and what it is, if any. */
function plainDataFault(
  value: unknown,
  path: string,
  seen: Set<object>,
): { path: string; what: string } | undefined {
  if (typeof value === 'function') return { path, what: 'a function' };
  if (typeof value === 'symbol') return { path, what: 'a symbol' };
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
  seen.add(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) && prototype === Array.prototype) {
    for (const [index, item] of value.entries()) {
      const fault = plainDataFault(item, `${path}[${String(index)}]`, seen);
      if (fault) return fault;
    }
    return undefined;
  }
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, item] of Object.entries(value)) {
      const where = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
      const fault = plainDataFault(item, `${path}${where}`, seen);
      if (fault) return fault;
    }
    return undefined;
  }
  if (value instanceof Map && prototype === Map.prototype) {
    const entries = [...(value as Map<unknown, unknown>).entries()];
    for (const [index, [key, item]] of entries.entries()) {
      const fault =
        plainDataFault(key, `${path}.keys()[${String(index)}]`, seen) ??
        plainDataFault(item, `${path}.values()[${String(index)}]`, seen);
      if (fault) return fault;
    }
    return undefined;
  }
  if (value instanceof Set && prototype === Set.prototype) {
    for (const [index, item] of [...(value as Set<unknown>)].entries()) {
      const fault = plainDataFault(item, `${path}.values()[${String(index)}]`, seen);
      if (fault) return fault;
    }
    return undefined;
  }
  if (PLAIN_BUILT_INS.includes(prototype as object)) return undefined;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return {
    path,
    what: typeof name === 'string' && name !== '' ? `a ${name}` : 'an object of a class',
  };
}
