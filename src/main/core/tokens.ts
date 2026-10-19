import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ID_PATTERN } from '../../shared/adapter';
import { DEFAULT_TOKEN_HOURS, MAX_TOKEN_HOURS } from '../../shared/api/limits';
import { isCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import { readWhole, unknownFields, writeWhole } from '../whole-file';
import type { OutsideCaller } from './caller';

/*
 * Outside tokens (decisions 8 and 20b; API Spec §8.5, Core Server §6.7): what an orchestrator
 * outside corrallm calls its MCP server with. Only a person makes one (`corrallm serve
 * --new-token`, and from B22 the app's settings page), and sees it once, as it is made: no
 * operation makes or widens one. A token is 256 random bits; the store keeps only its SHA-256 hash,
 * with its name (its party is `outside:<name>`), the canvases it reaches by their stable ids,
 * whether it may write, when it expires (an hour by default, 12 at most) and when it was last used,
 * in a file only the user may read:
 *
 *   { "version": 2, "tokens": { "<SHA-256 of the token, in hex>": { "id", "name", "canvases",
 *       "access", "expires", "lastUsed"? } } }
 *
 * A token made with the name of another replaces it at once: the party is the name's, so its
 * messages, its `wait` read position and the holds it set carry over. Its `id`, a random UUID,
 * names it among the store's tokens without its hash or its value: a caller's limits and repeated
 * requests are kept by it, and a call still going ends on it once its token is replaced or
 * expires. An entry that isn't one it writes reads as no token, and is dropped as the store is
 * written again; what it holds that this corrallm doesn't know (a newer one's fields, of the file
 * and of each token it reads) is written back as it was. A file of another version, or one that
 * isn't JSON, reads as none and is set aside (readWhole). One that can't be read is never read as
 * none, nor written over: the store refuses to load, so the core doesn't start without it.
 */

/** What a person makes a token for. */
export interface TokenGrant {
  /** Its party's name: an id (ID_PATTERN). */
  name: string;
  canvases: readonly CanvasId[];
  access: 'read' | 'write';
  /** How long it lasts, in hours: DEFAULT_TOKEN_HOURS unless given, MAX_TOKEN_HOURS at most. */
  hours?: number;
}

/** A token, as the store keeps it, by its hash. */
interface Kept {
  id: string;
  name: string;
  canvases: CanvasId[];
  access: 'read' | 'write';
  /** When it expires, in epoch ms. */
  expires: number;
  /** When it was last used, in epoch ms. */
  lastUsed?: number;
}

const VERSION = 2;
const HOUR = 60 * 60 * 1000;
/** How often, at most, a token's last use is written down as it is used. */
const LAST_USE_MS = 60 * 1000;
const HASH = /^[0-9a-f]{64}$/;
/** The fields of a token, as it keeps them. */
const FIELDS = ['id', 'name', 'canvases', 'access', 'expires', 'lastUsed'];

export class TokenStore {
  readonly #file: string;
  readonly #now: () => number;
  /** Every token kept, by its hash. */
  #tokens = new Map<string, Kept>();
  /** What its file holds that this corrallm doesn't know: of the file, and of each token read. */
  #unknown: Record<string, unknown> = {};
  readonly #fields = new WeakMap<Kept, Record<string, unknown>>();
  /** When each token's last use was last written down, by id: at most once a LAST_USE_MS. */
  readonly #written = new Map<string, number>();
  /** The tokens it knew that were replaced, or expired and dropped, by id. */
  readonly #revoked = new Set<string>();
  readonly #listeners = new Set<(id: string) => void>();
  #writing: Promise<void> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  /** Reads the tokens its file keeps, but those expired. Rejects if it can't be read. */
  async load(): Promise<void> {
    const file = await readWhole(this.#file, VERSION);
    this.#unknown = unknownFields(file, ['version', 'tokens']);
    this.#tokens = parse(file, this.#fields);
    this.#prune();
  }

  /**
   * Makes a token for `grant`: its value, returned once, never kept. It replaces any token of the
   * same name at once, and is written down, forced to disk, before it is returned: no power loss
   * brings the token it replaced back. Rejects a name that isn't an id, no canvases, or hours that
   * aren't 1 to MAX_TOKEN_HOURS.
   */
  async create({
    name,
    canvases,
    access,
    hours = DEFAULT_TOKEN_HOURS,
  }: TokenGrant): Promise<string> {
    if (!ID_PATTERN.test(name)) {
      throw new RangeError(
        `A token’s name is an id: a letter, then up to 31 letters, digits, dots, dashes or underscores, not “${name}”.`,
      );
    }
    if (canvases.length === 0) throw new RangeError('A token reaches one canvas at least.');
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_TOKEN_HOURS) {
      throw new RangeError(`A token lasts 1 to ${String(MAX_TOKEN_HOURS)} hours.`);
    }
    const token = randomBytes(32).toString('base64url');
    for (const [hash, kept] of this.#tokens) {
      if (kept.name === name) this.#revoke(hash);
    }
    this.#prune();
    this.#tokens.set(sha256(token), {
      id: randomUUID(),
      name,
      canvases: [...canvases],
      access,
      expires: this.#now() + hours * HOUR,
    });
    await this.#write(true);
    return token;
  }

  /** The outside orchestrator a token names, if it is one this store keeps that hasn't expired. */
  clientOf(token: string): OutsideCaller | undefined {
    const kept = this.#tokens.get(sha256(token));
    const now = this.#now();
    if (!kept || now >= kept.expires) return undefined;
    kept.lastUsed = now;
    const written = this.#written.get(kept.id);
    if (written === undefined || now - written >= LAST_USE_MS) {
      this.#written.set(kept.id, now);
      this.#write().catch((error: unknown) => {
        console.error('Could not keep when a token was last used:', error);
      });
    }
    return {
      kind: 'outside',
      token: kept.id,
      name: kept.name,
      access: kept.access,
      canvases: [...kept.canvases],
    };
  }

  /**
   * Whether the token `id` names was one of this store's that has been replaced or has expired:
   * what a call it made, still going, ends on. A caller it never made (a test's) is never revoked.
   */
  revoked(id: string): boolean {
    if (this.#revoked.has(id)) return true;
    const kept = [...this.#tokens.values()].find((token) => token.id === id);
    return kept !== undefined && this.#now() >= kept.expires;
  }

  /** When the token `id` names expires, in epoch ms: undefined for one this store doesn't keep. */
  expiresOf(id: string): number | undefined {
    return [...this.#tokens.values()].find((token) => token.id === id)?.expires;
  }

  /** Hears each token replaced, by id, as it is. */
  onRevoke(listener: (id: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Resolves once everything changed so far is written: when last used, too. */
  async flush(): Promise<void> {
    await this.#write();
  }

  #revoke(hash: string): void {
    const kept = this.#tokens.get(hash);
    if (!kept) return;
    this.#tokens.delete(hash);
    this.#revoked.add(kept.id);
    for (const listener of this.#listeners) listener(kept.id);
  }

  /** Drops the tokens that have expired. */
  #prune(): void {
    const now = this.#now();
    for (const [hash, kept] of this.#tokens) {
      if (now >= kept.expires) {
        this.#tokens.delete(hash);
        this.#revoked.add(kept.id);
      }
    }
  }

  /**
   * Writes the store whole, after every write before it, for the user's eyes only; `durable`,
   * forced to disk, as a write that replaces a token is: no power loss brings that one back.
   */
  #write(durable = false): Promise<void> {
    const write = this.#writing.then(() => {
      const tokens = [...this.#tokens].map(
        ([hash, kept]) => [hash, { ...this.#fields.get(kept), ...kept }] as const,
      );
      const file = { version: VERSION, ...this.#unknown, tokens: Object.fromEntries(tokens) };
      const text = `${JSON.stringify(file, null, 2)}\n`;
      return writeWhole(this.#file, text, { mode: 0o600, durable });
    });
    this.#writing = write.catch(() => undefined);
    return write;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The tokens a token file holds (none if there is none): those not right are left out. What each
 * holds that this corrallm doesn't know goes in `fields`.
 */
function parse(
  file: Record<string, unknown> | undefined,
  fields: WeakMap<Kept, Record<string, unknown>>,
): Map<string, Kept> {
  const tokens = new Map<string, Kept>();
  if (!isRecord(file?.tokens)) return tokens;
  for (const [hash, value] of Object.entries(file.tokens)) {
    const kept = readToken(value);
    if (!HASH.test(hash) || kept === undefined) continue;
    tokens.set(hash, kept);
    fields.set(kept, unknownFields(value, FIELDS));
  }
  return tokens;
}

/** A token as written: undefined if it is not right. */
function readToken(value: unknown): Kept | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, canvases, access, expires, lastUsed } = value;
  if (
    typeof id !== 'string' ||
    id === '' ||
    id.length > 64 ||
    typeof name !== 'string' ||
    !ID_PATTERN.test(name) ||
    !Array.isArray(canvases) ||
    canvases.length === 0 ||
    !canvases.every(isCanvasId) ||
    (access !== 'read' && access !== 'write') ||
    !Number.isSafeInteger(expires) ||
    (lastUsed !== undefined && !Number.isSafeInteger(lastUsed))
  ) {
    return undefined;
  }
  return {
    id,
    name,
    canvases,
    access,
    expires: expires as number,
    ...(lastUsed === undefined ? {} : { lastUsed: lastUsed as number }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
