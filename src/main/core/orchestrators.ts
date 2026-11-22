import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CanvasId } from '../../shared/canvas';
import { ApprovedOrchestrator, OPEN_APP } from '../../shared/model/orchestrators';
import type { OrchestratorsView } from '../../shared/model/orchestrators';
import { writeWhole } from '../whole-file';
import { mintTrustedPath } from './host';
import type { TrustedPath } from './host';
import { privateTokenProfile } from './token-profile';
import type { TokenStore } from './tokens';

export { OPEN_APP };
const ENDED = 'The orchestrator request ended without approval.';
const DECLINED = 'The orchestrator request was declined.';
const CHANGED = 'The folder or credential location changed. Ask again to review it.';
const Kept = ApprovedOrchestrator.extend({
  into: z.string().min(1).max(4096),
  revoked: z.int().nonnegative().nullable(),
  identity: z.string().min(1).max(200),
  fileHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type Kept = z.infer<typeof Kept>;
export type ConnectAnswer =
  | { ok: false; sentence: string }
  | { ok: true; op: 'connect'; canvas: string; folder: string; into: string; url: string | null };
interface Pending {
  view: OrchestratorsView['pending'][number];
  identity: string;
  parent: string;
  parentIdentity: string;
  deadline: number;
  finish: (answer: ConnectAnswer) => void;
  answer: Promise<ConnectAnswer>;
  stop: () => void;
}
interface Deps {
  file: string;
  tokens: TokenStore;
  /** Called only after the person's Allow and the directory's final identity check. */
  trusted: (id: string, folder: TrustedPath, previous?: CanvasId) => Promise<CanvasId>;
  changed: (canvas?: CanvasId) => void;
  current?: (canvas: CanvasId, folder: string) => boolean;
  notify?: (id: string) => void;
  unnotify?: (id: string) => void;
  home?: string;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const isOrchestratorName = (name: string) => /^orch-[a-f0-9]{27}$/.test(name);
const nameOf = (id: string) => `orch-${id.replaceAll('-', '').slice(0, 27)}`;
const inside = (file: string, folder: string) =>
  file === folder || file.startsWith(`${folder}${path.sep}`);
const identity = (s: { dev: number; ino: number; birthtimeMs: number }) =>
  `${String(s.dev)}:${String(s.ino)}:${String(s.birthtimeMs)}`;

/** Profile-owned approvals. Public operations can read/answer these only as the person. */
export class Orchestrators {
  readonly #deps: Deps;
  readonly #kept = new Map<string, Kept>();
  readonly #pending = new Map<string, Pending>();
  readonly #requests = new Map<string, Promise<ConnectAnswer>>();
  #lane: Promise<unknown> = Promise.resolve();
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#deps.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('The approved orchestrators could not be read.', { cause: error });
    }
    const file = z
      .strictObject({ version: z.literal(1), grants: z.array(Kept).max(256) })
      .parse(JSON.parse(text));
    for (const row of file.grants) this.#kept.set(row.id, row);
    // Revocation survives a crash between saving the decision and removing the bearer hash.
    for (const row of this.#kept.values())
      if (row.revoked !== null) await this.#deps.tokens.revoke(nameOf(row.id));
  }
  /** Begin maintenance only once the owner has finished composing the core. */
  async start(): Promise<void> {
    await this.renew(false).catch(() => { console.error('Approved orchestrator credentials could not be refreshed.'); });
    this.#timer ??= setInterval(() => {
      void this.renew(false).catch(() => {
        console.error('An approved orchestrator credential could not be renewed.');
      });
    }, 60_000).unref();
  }
  suppressNotifications(): void { for (const id of this.#pending.keys()) this.#deps.unnotify?.(id); }
  pendingCount(): number {
    return this.#pending.size;
  }
  view(): OrchestratorsView {
    return {
      approved: [...this.#kept.values()]
        .filter((row) => row.revoked === null)
        .map(({ id, folder, canvas, withoutApprovals, created, lastUsed }) => ({
          id,
          folder,
          canvas,
          withoutApprovals,
          created,
          lastUsed,
        })),
      pending: [...this.#pending.values()].map(({ view }) => ({ ...view })),
    };
  }
  /** A grant bearer is confined to this canvas, even if ordinary tokens can create canvases. */
  canvas(name: string): CanvasId | undefined {
    const row = [...this.#kept.values()].find((one) => nameOf(one.id) === name);
    return row?.revoked === null && this.#deps.current?.(row.canvas as CanvasId, row.folder) !== false ? (row.canvas as CanvasId) : undefined;
  }
  keeps(canvas: CanvasId): boolean {
    return [...this.#kept.values()].some((row) => row.canvas === canvas && row.revoked === null);
  }
  name(canvas: CanvasId): string | undefined {
    const row = [...this.#kept.values()].find((one) => one.canvas === canvas);
    return row === undefined ? undefined : path.basename(row.folder);
  }
  isName(name: string): boolean {
    return isOrchestratorName(name);
  }
  used(name: string): void {
    const row = [...this.#kept.values()].find(
      (one) => nameOf(one.id) === name && one.revoked === null,
    );
    if (row !== undefined) row.lastUsed = Date.now();
  }
  request(
    input: { folder: string; into: string; timeout: number },
    signal?: AbortSignal,
  ): Promise<ConnectAnswer> {
    const key = JSON.stringify([input.folder, input.into]);
    const same = this.#requests.get(key);
    if (same !== undefined) return same;
    const answer = this.#request(input, signal).finally(() => {
      this.#requests.delete(key);
    });
    this.#requests.set(key, answer);
    return answer;
  }
  async #request(
    { folder, into, timeout }: { folder: string; into: string; timeout: number },
    signal?: AbortSignal,
  ): Promise<ConnectAnswer> {
    if (this.#stopped(signal)) return { ok: false, sentence: ENDED };
    try {
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
        throw new Error('The request timeout must be 1 to 3600 seconds.');
      const canonical = await this.#folder(folder);
      const parent = await this.#parent(into, canonical);
      const folderIdentity = identity(await lstat(canonical));
      const parentIdentity = identity(await lstat(parent));
      const known = [...this.#kept.values()].find(
        (one) => one.folder === canonical && one.into === into,
      );
      const exists = await lstat(into).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (exists !== undefined) {
        if (known === undefined) throw new Error('Choose a new credential file.');
        if (
          (await this.#fileHash(into)) !== known.fileHash &&
          !this.#deps.tokens.matchesHash(nameOf(known.id), await this.#fileHash(into))
        )
          throw new Error('Choose this approval’s existing private file.');
      }
      if (known?.revoked === null && known.identity === folderIdentity) {
        if (this.#deps.current?.(known.canvas as CanvasId, canonical) === false) throw new Error('The approved canvas no longer uses this folder. Revoke its approval in Settings and request another.');
        await this.#queue(async () => {
          const current = this.#kept.get(known.id);
          if (current?.revoked !== null || this.#stopped()) throw new Error(ENDED);
          const live = this.#deps.tokens.grant(nameOf(current.id));
          if (exists === undefined || live === undefined || !this.#deps.tokens.matchesHash(nameOf(current.id), current.fileHash) || live.expires - Date.now() <= 15 * 60_000)
            await this.#issue(current);
        });
        return {
          ok: true,
          op: 'connect',
          canvas: known.canvas,
          folder: canonical,
          into,
          url: null,
        };
      }
      if (this.#stopped(signal)) return { ok: false, sentence: ENDED };
      const same = [...this.#pending.values()].find((one) => one.view.folder === canonical);
      if (same !== undefined) {
        if (same.view.into !== into)
          throw new Error(
            'A request for this folder is already waiting with another credential file.',
          );
        return await same.answer;
      }
      if (this.#pending.size >= 8 || this.view().approved.length >= 128)
        throw new Error(
          'Too many orchestrator requests or approvals are kept. Decline or revoke one first.',
        );
      const id = randomUUID();
      let finish!: (answer: ConnectAnswer) => void;
      const answer = new Promise<ConnectAnswer>((resolve) => {
        finish = resolve;
      });
      const end = () => {
        this.#end(id, { ok: false, sentence: ENDED });
      };
      const timer = setTimeout(end, timeout * 1000);
      signal?.addEventListener('abort', end, { once: true });
      this.#pending.set(id, {
        view: {
          id,
          folder: canonical,
          into,
          requester: 'an agent',
          expires: Date.now() + timeout * 1000,
        },
        identity: folderIdentity,
        parent,
        parentIdentity,
        deadline: performance.now() + timeout * 1000,
        answer,
        finish,
        stop: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', end);
        },
      });
      this.#deps.changed();
      this.#deps.notify?.(id);
      return await answer;
    } catch (error) {
      return {
        ok: false,
        sentence: error instanceof Error ? error.message : 'The request could not be checked.',
      };
    }
  }
  answer(
    id: string,
    choice: 'allow' | 'decline',
    withoutApprovals: boolean,
    committing: () => void = () => undefined,
  ): Promise<void> {
    return this.#queue(async () => {
      const pending = this.#pending.get(id);
      if (pending === undefined || performance.now() >= pending.deadline || this.#stopped()) {
        this.#end(id, { ok: false, sentence: ENDED });
        throw new Error(ENDED);
      }
      if (choice === 'decline') {
        committing();
        this.#end(id, { ok: false, sentence: DECLINED });
        return;
      }
      try {
        const { folder, into } = pending.view;
        if (
          (await this.#folder(folder)) !== folder ||
          identity(await lstat(folder)) !== pending.identity ||
          (await this.#parent(into, folder)) !== pending.parent ||
          identity(await lstat(pending.parent)) !== pending.parentIdentity
        )
          throw new Error(CHANGED);
        if (
          this.#pending.get(id) !== pending ||
          performance.now() >= pending.deadline ||
          this.#stopped()
        )
          throw new Error(ENDED);
        committing();
        // This Allow is the sole new trust source. No request or command-line path is branded.
        pending.stop();
        const trusted = mintTrustedPath(folder);
        const previous = [...this.#kept.values()].find((row) => row.folder === folder);
        const canvas = await this.#deps.trusted(
          id,
          trusted,
          previous !== undefined && this.#deps.current?.(previous.canvas as CanvasId, folder) !== false ? previous.canvas as CanvasId : undefined,
        );
        const created = Date.now();
        const row: Kept = {
          id,
          folder,
          into,
          canvas,
          withoutApprovals,
          identity: pending.identity,
          ...(previous?.into === into && previous.fileHash !== undefined
            ? { fileHash: previous.fileHash }
            : {}),
          created,
          lastUsed: created,
          revoked: created,
        };
        // Keep the approval before issuing any bearer. An incomplete issuance stays inactive after recovery.
        if (previous?.revoked === null) await this.#revoke(previous.id);
        await this.#save(row);
        await this.#issue(row);
        const issued = this.#kept.get(id);
        if (issued === undefined) throw new Error(ENDED);
        await this.#save({ ...issued, revoked: null });
        this.#end(id, { ok: true, op: 'connect', canvas, folder, into, url: null });
      } catch (error) {
        this.#end(id, {
          ok: false,
          sentence: 'The orchestrator approval could not be completed. Ask again.',
        });
        throw error;
      }
    });
  }
  revoke(id: string, committing: () => void = () => undefined): Promise<boolean> {
    return this.#queue(async () => {
      if (this.#kept.get(id)?.revoked !== null) return false;
      committing();
      await this.#revoke(id);
      return true;
    });
  }
  async #revoke(id: string): Promise<void> {
    const row = this.#kept.get(id);
    if (row?.revoked !== null) throw new Error('That orchestrator approval is no longer current.');
    await this.#save({ ...row, revoked: Date.now() });
    await this.#deps.tokens.revoke(nameOf(id));
  }
  renew(force = true): Promise<void> {
    return this.#queue(async () => {
      for (const row of this.#kept.values()) {
        if (this.#closed || row.revoked !== null) continue;
        const live = this.#deps.tokens.grant(nameOf(row.id));
        if (
          force ||
          live === undefined ||
          !this.#deps.tokens.matchesHash(nameOf(row.id), row.fileHash) ||
          live.expires - Date.now() <= 15 * 60_000
        ) {
          try { await this.#issue(row); }
          catch {
            await this.#deps.tokens.revoke(nameOf(row.id)).catch(() => undefined);
            console.error('An approved orchestrator credential could not be renewed; its bearer is refused.');
          }
        }
      }
      if (!this.#closed) await this.#save();
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const id of this.#pending.keys()) this.#end(id, { ok: false, sentence: ENDED });
    await this.#lane;
  }
  async #issue(row: Kept): Promise<void> {
    if (this.#closed) throw new Error(ENDED);
    if (
      (await this.#folder(row.folder)) !== row.folder ||
      identity(await lstat(row.folder)) !== row.identity
    )
      throw new Error(CHANGED);
    const parent = await this.#parent(row.into, row.folder);
    const before = await lstat(row.into).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (before !== undefined) {
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o077) !== 0 ||
        ((await this.#fileHash(row.into)) !== row.fileHash &&
          !this.#deps.tokens.matchesHash(nameOf(row.id), await this.#fileHash(row.into)))
      )
        throw new Error(
          'The credential file is not this approval’s last credential. Choose a new file.',
        );
    }
    const token = await this.#deps.tokens.create({
      name: nameOf(row.id),
      canvases: [row.canvas as CanvasId],
      access: 'write',
      hours: 1,
    });
    const partial = path.join(parent, `.${randomUUID()}.partial`);
    try {
      const handle = await open(
        partial,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${token}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.#parent(row.into, row.folder)) !== parent) throw new Error(CHANGED);
      if (before === undefined) await link(partial, row.into);
      else {
        const current = await lstat(row.into);
        if (!current.isFile() || identity(current) !== identity(before)) throw new Error(CHANGED);
        await rename(partial, row.into);
      }
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await this.#save({ ...row, fileHash: hash(token) });
    } catch (error) {
      await this.#deps.tokens.revoke(nameOf(row.id));
      throw error;
    } finally {
      await rm(partial, { force: true });
    }
  }
  async #fileHash(file: string): Promise<string> {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 1024
      )
        throw new Error('The credential file is not an owner-only token file.');
      const data = Buffer.alloc(1025);
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await handle.read(data, size, data.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 1024) throw new Error('The credential file is too large.');
      return hash(data.subarray(0, size).toString('utf8').trim());
    } finally {
      await handle.close();
    }
  }
  async #save(row?: Kept): Promise<void> {
    if (row === undefined && this.#kept.size === 0) return;
    const next = new Map(this.#kept);
    if (row !== undefined) next.set(row.id, row);
    if (next.size > 256) {
      const past = [...next.values()].filter((one) => one.revoked !== null && one.id !== row?.id).sort((a, b) => a.created - b.created);
      for (const old of past) { if (next.size <= 256) break; next.delete(old.id); }
    }
    await writeWhole(
      this.#deps.file,
      `${JSON.stringify({ version: 1, grants: [...next.values()] })}\n`,
      { mode: 0o600, durable: true },
    );
    for (const id of this.#kept.keys()) if (!next.has(id)) this.#kept.delete(id);
    for (const [id, kept] of next) this.#kept.set(id, kept);
    this.#deps.changed(row?.canvas as CanvasId | undefined);
  }
  #end(id: string, answer: ConnectAnswer): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    pending.stop();
    this.#pending.delete(id);
    pending.finish(answer);
    this.#deps.unnotify?.(id);
    this.#deps.changed();
  }
  #stopped(signal?: AbortSignal): boolean {
    return this.#closed || signal?.aborted === true;
  }
  #queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lane.then(run);
    this.#lane = next.catch(() => undefined);
    return next;
  }
  async #folder(folder: string): Promise<string> {
    const canonical = await realpath(folder);
    const home = await realpath(this.#deps.home ?? homedir());
    const blocked = [
      '/usr',
      '/etc',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/System',
      '/Library',
      '/dev',
      '/proc',
      '/sys',
      '/var',
      '/private/etc',
      '/Applications',
      '/boot',
      '/run',
      '/root',
    ];
    if (
      ['/home', '/Users', '/tmp', '/private/tmp', '/private/var', '/Volumes'].includes(canonical) ||
      canonical === home ||
      canonical === path.parse(canonical).root ||
      blocked.some((one) => inside(canonical, one)) ||
      !(await lstat(canonical)).isDirectory()
    )
      throw new Error('Choose a project folder, not home, root or a system folder.');
    return canonical;
  }
  async #parent(into: string, folder: string): Promise<string> {
    if (
      !path.isAbsolute(into) ||
      path.resolve(into) !== into ||
      !into.isWellFormed() ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(into) ||
      into.length > 4096
    )
      throw new Error('Choose an absolute, single-line credential-file path.');
    const parent = await privateTokenProfile(path.dirname(into));
    if (parent !== path.dirname(into) || inside(into, folder))
      throw new Error(
        'Keep the credential file outside the approved folder, without directory links.',
      );
    const info = await lstat(parent);
    if ((info.mode & 0o077) !== 0)
      throw new Error('Keep the credential file in an owner-only folder (0700).');
    const found = await lstat(into).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (found !== undefined && !found.isFile())
      throw new Error('The credential file must not be a link or another kind of file.');
    return parent;
  }
}
