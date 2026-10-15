import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { WebContents } from 'electron';

import { MAX_CANVAS_BYTES } from '../shared/ipc';
import { MAX_RUN_BYTES, parseRunCheckpoint } from '../shared/run';
import type { RunCheckpoint, RunContext } from '../shared/run';
import { associateCanvas, canvasFile, forgetCanvas } from './canvas';
import { writeWhole } from './memory';
import type { CanvasMemory, Remembered } from './memory';
import { isSessionId } from './sessions/id';

interface Entry {
  identity: string;
  canvas?: string;
  token: string;
  warning?: string;
}
interface RecordFile {
  checkpoint: RunCheckpoint;
  remembered?: Remembered;
}
interface JournalDeps {
  memory: CanvasMemory;
  projectOf(contents: WebContents): string | undefined;
  restored(contents: WebContents): Promise<void>;
  settled?(contents: WebContents): Promise<void>;
}

/** Atomic per-canvas journals plus the profile's last active named canvas or durable draft. */
export class RunJournal {
  readonly #directory: string;
  readonly #deps: JournalDeps;
  readonly #entries = new WeakMap<WebContents, Entry>();
  readonly #opening = new WeakMap<WebContents, Promise<Entry>>();
  #writing: Promise<void> = Promise.resolve();

  constructor(directory: string, deps: JournalDeps) {
    this.#directory = directory;
    this.#deps = deps;
  }

  /** Internal memory key: drafts have durable identities but never masquerade as saved files. */
  identity(contents: WebContents): string | undefined {
    return canvasFile(contents) ?? this.#entries.get(contents)?.identity;
  }

  has(contents: WebContents): boolean {
    return this.#entries.has(contents);
  }

  async get(contents: WebContents): Promise<RunContext> {
    const entry = await this.#entry(contents);
    await this.#deps.settled?.(contents);
    await this.flush();
    const record = await this.#read(entry.identity);
    const folder = this.#deps.projectOf(contents);
    let savedText: string | undefined;
    if (entry.canvas !== undefined) {
      try {
        savedText = await canvasText(entry.canvas);
      } catch (error) {
        if (!missing(error)) throw error;
        await this.#toDraft(contents, entry);
      }
    }
    return {
      token: entry.token,
      checkpoint: record?.checkpoint ?? null,
      name: entry.canvas === undefined ? null : path.basename(entry.canvas),
      ...(folder === undefined ? {} : { project: { name: path.basename(folder), path: folder } }),
      ...(savedText === undefined ? {} : { savedText }),
      ...(entry.warning === undefined ? {} : { warning: entry.warning }),
    };
  }

  async save(
    contents: WebContents,
    token: string,
    checkpoint: RunCheckpoint | null,
  ): Promise<void> {
    const entry = await this.#entry(contents);
    if (this.#entries.get(contents) !== entry || entry.token !== token) {
      throw new Error('This run belongs to an earlier canvas');
    }
    if (checkpoint !== null) {
      parseRunCheckpoint(checkpoint);
      if (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_RUN_BYTES) {
        throw new RangeError('The run checkpoint is too large');
      }
    }
    const remembered = await this.#deps.memory.get(entry.identity);
    return this.#serialize(async () => {
      if (this.#entries.get(contents) !== entry || entry.token !== token) {
        throw new Error('This run belongs to an earlier canvas');
      }
      if (checkpoint === null) await rm(this.#file(entry.identity), { force: true });
      else await this.#write(entry.identity, { checkpoint, remembered });
      await this.#last(entry);
    });
  }

  /** Call after a successful Open; the old generation can no longer save to this canvas. */
  async opened(contents: WebContents): Promise<void> {
    const canvas = canvasFile(contents);
    if (canvas === undefined) throw new Error('No canvas was opened');
    const entry = { identity: canvas, canvas, token: randomUUID() };
    this.#entries.set(contents, entry);
    await this.#serialize(() => this.#last(entry));
  }

  /** Save As copies metadata and IDs; the original named canvas keeps its own journal. */
  async saved(contents: WebContents): Promise<void> {
    const before = this.#entries.get(contents);
    const canvas = canvasFile(contents);
    if (canvas === undefined) return;
    if (before?.identity === canvas) return;
    let migration: Promise<void> | undefined;
    try {
      await this.flush();
      const record = before === undefined ? undefined : await this.#read(before.identity);
      const remembered =
        before === undefined ? undefined : await this.#deps.memory.get(before.identity);
      const entry = { identity: canvas, canvas, token: randomUUID() };
      if (remembered !== undefined) await this.#deps.memory.update(canvas, () => remembered);
      migration = this.#serialize(async () => {
        if (record !== undefined) await this.#write(canvas, record);
        await this.#last(entry);
      });
      await migration;
      this.#entries.set(contents, entry);
    } catch (error) {
      // The target canvas file may already exist, but a failed metadata migration must keep the
      // renderer's old token usable and its next ordinary Save pointed at the original canvas.
      if (before === undefined) this.#entries.delete(contents);
      else this.#entries.set(contents, before);
      if (before?.canvas === undefined) forgetCanvas(contents);
      else associateCanvas(contents, before.canvas);
      // This migration's error reaches its caller; it must not poison reads of the intact old run.
      if (migration !== undefined && this.#writing === migration) {
        this.#writing = migration.catch(() => undefined);
      }
      throw error;
    }
  }

  /** New intentionally starts a new durable draft; named journals remain available. */
  async forgotten(contents: WebContents): Promise<void> {
    const entry = draft();
    this.#entries.set(contents, entry);
    await this.#serialize(() => this.#last(entry));
  }

  flush(): Promise<void> {
    return this.#writing;
  }

  #entry(contents: WebContents): Promise<Entry> {
    let opening = this.#opening.get(contents);
    if (opening !== undefined) return opening;
    const entry = this.#entries.get(contents);
    if (entry !== undefined) return Promise.resolve(entry);
    opening = this.#restore(contents);
    this.#opening.set(contents, opening);
    void opening.finally(() => this.#opening.delete(contents)).catch(() => undefined);
    return opening;
  }

  async #restore(contents: WebContents): Promise<Entry> {
    let entry: Entry;
    const canvas = canvasFile(contents);
    if (canvas !== undefined) entry = { identity: canvas, canvas, token: randomUUID() };
    else {
      let last: unknown;
      try {
        last = JSON.parse(await readFile(path.join(this.#directory, 'last.json'), 'utf8'));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (last === undefined) entry = draft();
      else {
        if (!isLast(last)) {
          throw new Error('The saved run context is invalid');
        }
        entry = {
          identity: last.identity,
          token: randomUUID(),
          ...(typeof last.canvas === 'string' ? { canvas: last.canvas } : {}),
        };
      }
    }
    this.#entries.set(contents, entry);
    if (entry.canvas !== undefined) {
      try {
        await canvasText(entry.canvas);
        associateCanvas(contents, entry.canvas);
      } catch (error) {
        if (!missing(error)) throw error;
        await this.#toDraft(contents, entry);
      }
    }
    const record = await this.#read(entry.identity);
    if (record?.remembered !== undefined) {
      const backup = record.remembered;
      // A present record is authoritative, including IDs intentionally cleared by a project
      // change or rewind. The checkpoint backup only recovers missing canvas memory.
      await this.#deps.memory.update(entry.identity, (current, known) =>
        known ? current : backup,
      );
    }
    await this.#deps.restored(contents);
    await this.#serialize(() => this.#last(entry));
    return entry;
  }

  async #toDraft(contents: WebContents, entry: Entry): Promise<void> {
    const record = await this.#read(entry.identity);
    const remembered = await this.#deps.memory.get(entry.identity);
    Object.assign(entry, draft(), {
      warning: 'The saved canvas is missing. Its run was restored as an unsaved canvas.',
    });
    delete entry.canvas;
    forgetCanvas(contents);
    await this.#deps.memory.update(entry.identity, () => remembered);
    await this.#serialize(async () => {
      if (record !== undefined) await this.#write(entry.identity, record);
      await this.#last(entry);
    });
  }

  #file(identity: string): string {
    return path.join(
      this.#directory,
      `${createHash('sha256').update(identity).digest('hex')}.json`,
    );
  }

  async #read(identity: string): Promise<RecordFile | undefined> {
    try {
      const file = this.#file(identity);
      if ((await stat(file)).size > MAX_RUN_BYTES * 2)
        throw new Error('The saved run is too large');
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isRecord(value) || value.version !== 1) throw new Error('The saved run is invalid');
      const memory = remembered(value.remembered);
      return {
        checkpoint: parseRunCheckpoint(value.checkpoint),
        ...(memory === undefined ? {} : { remembered: memory }),
      };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async #write(identity: string, record: RecordFile): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await writeWhole(this.#file(identity), JSON.stringify({ version: 1, ...record }));
  }

  async #last(entry: Entry): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const lastFile = path.join(this.#directory, 'last.json');
    let rejected = false;
    try {
      rejected = !isLast(JSON.parse(await readFile(lastFile, 'utf8')));
    } catch (error) {
      if (error instanceof SyntaxError) rejected = true;
      else if (!missing(error)) throw error;
    }
    if (rejected) {
      await copyFile(lastFile, path.join(this.#directory, `last.rejected-${randomUUID()}.json`));
    }
    await writeWhole(
      path.join(this.#directory, 'last.json'),
      JSON.stringify({
        version: 1,
        identity: entry.identity,
        ...(entry.canvas === undefined ? {} : { canvas: entry.canvas }),
      }),
    );
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const writing = this.#writing.catch(() => undefined).then(operation);
    this.#writing = writing;
    return writing;
  }
}

function draft(): Entry {
  return { identity: `draft:${randomUUID()}`, token: randomUUID() };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
async function canvasText(file: string): Promise<string> {
  if ((await stat(file)).size > MAX_CANVAS_BYTES) throw new Error('The saved canvas is too large');
  return readFile(file, 'utf8');
}
function remembered(value: unknown): Remembered | undefined {
  if (!isRecord(value)) return undefined;
  const ids = (record: unknown) =>
    Object.fromEntries(
      Object.entries(isRecord(record) ? record : {}).filter((entry): entry is [string, string] =>
        isSessionId(entry[1]),
      ),
    );
  return {
    sessions: ids(value.sessions),
    threads: ids(value.threads),
    ...(typeof value.project === 'string' ? { project: value.project } : {}),
  };
}

function isLast(value: unknown): value is { version: 1; identity: string; canvas?: string } {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.identity === 'string' &&
    (value.identity.startsWith('draft:') || path.isAbsolute(value.identity)) &&
    (value.canvas === undefined ||
      (typeof value.canvas === 'string' && path.isAbsolute(value.canvas)))
  );
}
