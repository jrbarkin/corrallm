// Throwaway G2 diagnosis: installed before the CLI imports built-ins. No parameters or text are
// retained, only operation/table names and monotonic timings. No per-event disk or console I/O.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';

export function installDiagnostics() {
  if (process.env.CORRALLM_G2_DIAG !== '1') return undefined;
  const now = () => Number(process.hrtime.bigint() / 1000n);
  const events = [];
  const marks = [];
  const pending = new Set();
  const captures = new WeakMap();
  let dropped = 0;
  let cursor = 0;
  let anchorBefore = 0;
  let anchorAfter = 0;
  const record = (event) => {
    if (events.length < 200000) events.push(event);
    else {
      events[cursor] = event;
      cursor = (cursor + 1) % events.length;
      dropped++;
    }
  };
  const wrap = (endpoint, lane) => {
    const asked = new Map();
    const post = endpoint.postMessage.bind(endpoint);
    endpoint.postMessage = (message, ...args) => {
      if (typeof message?.id === 'number') {
        const op =
          message.op === 'sync'
            ? `sync ${message.request?.op}`
            : (message.op ??
              (message.partial ? 'snapshot' : message.vacuum ? 'vacuum' : 'checkpoint'));
        const event = { lane: `${lane}-wait`, op, start: now() };
        asked.set(message.id, event);
        pending.add(event);
      }
      return post(message, ...args);
    };
    const capture = (message) => {
      if (message?.g2) record(message.g2);
      const event = asked.get(message?.id);
      if (event) {
        asked.delete(message.id);
        pending.delete(event);
        record({ ...event, end: now() });
      }
    };
    endpoint.on('message', capture);
    captures.set(endpoint, capture);
  };
  // Inject at the worker's handler, so execution time is distinct from request round-trip time.
  // Its existing replies carry the timings; no extra messages can race a synchronous reply.
  const prelude = (lane) => `;(() => {
    const { workerData, parentPort } = require('node:worker_threads');
    const { AsyncLocalStorage } = require('node:async_hooks');
    const target = workerData.port || parentPort;
    const context = new AsyncLocalStorage();
    const labels = new Map();
    const label = step => {
      if (step.sql !== undefined) {
        const verb = step.sql.trim().match(/^\\w+/)?.[0] || 'SQL';
        const table = step.sql.match(/(?:INTO|UPDATE|FROM)\\s+["\x60]?([a-z_]+)/i)?.[1] || '';
        labels.set(step.id, verb + (table ? ' ' + table : ''));
      }
      return labels.get(step.id) || 'SQL';
    };
    const describe = message => {
      if (message.op === 'sync') return 'sync ' + message.request.op + (message.request.statement ? ' ' + label(message.request.statement) : '');
      if (message.steps) return message.op + '[' + message.steps.length + '] ' + [...new Set(message.steps.map(label))].join(',');
      return message.op || (message.partial ? 'snapshot' : message.vacuum ? 'vacuum' : 'checkpoint');
    };
    const on = target.on.bind(target);
    target.on = (name, handler) => on(name, name !== 'message' ? handler : message =>
      context.run({ lane: ${JSON.stringify(lane)}, op: describe(message), start: Number(process.hrtime.bigint() / 1000n) }, () => handler(message)));
    const post = target.postMessage.bind(target);
    target.postMessage = (message, ...args) => {
      const event = context.getStore();
      return post(event ? { ...message, g2: { ...event, end: Number(process.hrtime.bigint() / 1000n) } } : message, ...args);
    };
  })();\n`;
  const { Worker, MessageChannel, receiveMessageOnPort } = threads;
  threads.Worker = class extends Worker {
    constructor(source, options) {
      const lane =
        options?.eval && typeof source === 'string'
          ? options.workerData?.port
            ? 'writer'
            : source.includes('PRAGMA wal_checkpoint(PASSIVE)')
              ? 'checkpointer'
              : undefined
          : undefined;
      super(lane ? prelude(lane) + source : source, options);
      if (lane) wrap(this, lane);
    }
  };
  threads.MessageChannel = class extends MessageChannel {
    constructor() {
      super();
      wrap(this.port1, 'writer');
    }
  };
  threads.receiveMessageOnPort = (port) => {
    const result = receiveMessageOnPort(port);
    if (result) captures.get(port)?.(result.message);
    return result;
  };
  const flush = fs.fsync;
  fs.fsync = (fd, callback) => {
    const event = { lane: 'fsync', op: 'flush', start: now() };
    pending.add(event);
    return flush(fd, (error) => {
      pending.delete(event);
      record({ ...event, end: now() });
      callback(error);
    });
  };
  const sync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const start = now();
    try {
      return sync(fd);
    } finally {
      record({ lane: 'fsync-sync', op: 'flush', start, end: now() });
    }
  };
  syncBuiltinESMExports();
  return {
    now,
    anchor: (before, after) => {
      anchorBefore = before;
      anchorAfter = after;
    },
    mark: () => marks.push(now()),
    snapshot: (profileStart) => {
      // V8 and hrtime have different epochs on macOS. Bound the alignment error by the
      // Profiler.start round trip; all worker clocks are process.hrtime on this host.
      const offset = profileStart - (anchorBefore + anchorAfter) / 2;
      const captured = [
        ...events.slice(cursor),
        ...events.slice(0, cursor),
        ...[...pending].map((event) => ({ ...event, end: now(), pending: true })),
      ];
      return {
        marks: marks.map((at) => at + offset),
        clockUncertaintyUs: (anchorAfter - anchorBefore) / 2,
        dropped,
        events: captured.map((event) => ({
          ...event,
          start: event.start + offset,
          end: event.end + offset,
        })),
      };
    },
  };
}
