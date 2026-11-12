import type { Catalog } from '../../shared/adapter';
import type { HeldReason, LeadGrants, LeadView } from '../../shared/api/ops/leads';
import type { CanvasId } from '../../shared/canvas';
import type { AgentData, AgentNode, CanvasDocument } from '../../shared/model/canvas';
import { agentEndpoint } from '../../shared/model/catalog';
import type { CanvasMemory } from '../memory';
import { roleFingerprint } from '../memory';
import type { Staged } from './delivery/messages';
import type { Database } from './store/store';

export type { HeldReason, LeadGrants as Grants } from '../../shared/api/ops/leads';

/*
 * Who leads (B24 Design §3, C1, C2): each agent you made a lead of the agents nested in it, with what
 * it may answer for them (its grants), and what it was when you did (its fingerprint: its role's
 * SHA-256, never the role's text, and the adapter and connection its endpoint resolves to). Kept in
 * the profile's database (`lead`, schema 14) and in memory, read once as the core opens, written
 * only through the store's lane, each change on disk before it resolves; never in a canvas file,
 * which nothing of it reads or writes.
 *
 * A lead is one only while it isn't held and its agent is still what it was. The first commit that
 * changes its agent's adapter, connection or role holds it (`held`, which says which), durably, in
 * that commit's write, whatever made the commit: so changing the role back never makes it a lead
 * again unasked. You confirm it by making it a lead again with the same grants, as its agent is
 * then. A commit that removes its agent deletes its row in the same write (a failed commit keeps
 * it), and the rows of agents a canvas no longer has go as its document loads, so no row outlives
 * its agent into a later agent of the same id: its fingerprint is the second guard. Its canvas
 * forgotten, its rows go with it (ON DELETE CASCADE).
 *
 * `isLead` is a lookup of the row and of its agent's node in the document now, its fingerprint
 * worked out once for each node's data (kept by reference across revisions it doesn't change),
 * never hashing a role per call.
 *
 * And the outside orchestrators, by their token's name, you let answer ordinary approvals on a
 * canvas (`outside_grant`, Q3): set only by `outside.setGrant`, yours alone, and kept when the
 * token expires or is revoked, until you remove it.
 */

/** What an agent was when you made it a lead: its role's fingerprint, adapter and connection. */
export interface Fingerprint {
  readonly v: 1;
  /** Its role's SHA-256, or 'none' (roleFingerprint). */
  readonly role: string;
  readonly adapter: string;
  readonly connection: string;
}

/** A lead as kept, in memory. */
interface Lead {
  readonly grants: LeadGrants;
  readonly fingerprint: Fingerprint;
  /** What changed of its agent since, holding it until you confirm it: none while it leads. */
  readonly held: HeldReason | undefined;
}

export interface LeadStoreDeps {
  /** The profile's database, which keeps the leads and the outside grants. */
  store: Database;
  /**
   * Canvas memory: a canvas's row, which its leads refer to, and what it forgets, with which its
   * leads go (ON DELETE CASCADE).
   */
  memory: Pick<CanvasMemory, 'ensure' | 'keeps' | 'subscribe'>;
  /** What an agent's endpoint is read against. */
  catalog: Catalog;
  /** A canvas's document as the core has it now: none while it isn't loaded. */
  document: (canvas: CanvasId) => CanvasDocument | undefined;
  now?: () => number;
  /**
   * Told once a change of a canvas's leads or outside grants is on disk and in memory: whoever
   * leads, or may answer, there may have changed (its topic, its Needs, and from C2 the routes of
   * its prompts). `lead`: the one you made, confirmed or removed (`set`), if it was one lead you
   * changed, whose refusals count starts again; a grant, a hold or a deletion names none.
   */
  changed?: (canvas: CanvasId, lead?: string) => void;
}

const GRANT_KEYS = ['questions', 'plans', 'approvals'] as const;
const ROLE = /^(?:none|[0-9a-f]{64})$/;

export class LeadStore {
  readonly #deps: LeadStoreDeps;
  readonly #now: () => number;
  /** Each canvas's leads, by agent. */
  readonly #leads = new Map<CanvasId, Map<string, Lead>>();
  /** Each canvas's rows this code can't read, by agent: no lead, kept as they are until removed. */
  readonly #unread = new Map<CanvasId, Set<string>>();
  /** Each canvas's outside grants: the token names you let answer approvals there. */
  readonly #grants = new Map<CanvasId, Set<string>>();
  /** Each document's agents, by id: indexed once. */
  readonly #agents = new WeakMap<CanvasDocument, ReadonlyMap<string, AgentNode>>();
  /** Each agent's data's fingerprint (none: its endpoint isn't known), worked out once. */
  readonly #fingerprints = new WeakMap<AgentData, Fingerprint | null>();
  /** Why the leads couldn't be read as the core opened, if they couldn't. */
  warning: string | undefined;

  constructor(deps: LeadStoreDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    // Canvas memory says only that which canvases it keeps changed as it forgets one (within the
    // write that does): what this keeps of a canvas it no longer has goes too, so no lead outlives
    // its canvas's rows in memory.
    deps.memory.subscribe((canvas) => {
      if (canvas === undefined) this.#forgotten();
    });
  }

  /** Reads what the database keeps of every canvas's leads and outside grants. Never throws. */
  load(): void {
    this.#leads.clear();
    this.#unread.clear();
    this.#grants.clear();
    let leads: Record<string, unknown>[];
    let grants: Record<string, unknown>[];
    try {
      const { store } = this.#deps;
      leads = store
        .prepare('SELECT canvas_id, agent_id, grants, fingerprint, held FROM lead')
        .all();
      grants = store.prepare('SELECT canvas_id, name FROM outside_grant').all();
    } catch (error) {
      // None leads, and nothing is granted: the narrower reading of what can't be read.
      this.warning = `Who leads could not be read (${error instanceof Error ? error.message : String(error)}).`;
      return;
    }
    for (const row of leads) {
      const canvas = String(row.canvas_id) as CanvasId;
      const agent = String(row.agent_id);
      const lead = readLead(row);
      if (lead === undefined) setOf(this.#unread, canvas).add(agent);
      else mapOf(this.#leads, canvas).set(agent, lead);
    }
    for (const row of grants) {
      setOf(this.#grants, String(row.canvas_id) as CanvasId).add(String(row.name));
    }
  }

  /**
   * What `data`'s agent is, as a lead's fingerprint says it: none if its endpoint isn't known
   * (unchosen, or an adapter or connection this build lacks), which can't lead.
   */
  fingerprintOf(data: AgentData): Fingerprint | undefined {
    let known = this.#fingerprints.get(data);
    if (known === undefined) {
      const endpoint = agentEndpoint(data, this.#deps.catalog);
      known =
        endpoint.kind === 'known'
          ? {
              v: 1,
              role: roleFingerprint(data.role),
              adapter: endpoint.adapter,
              connection: endpoint.connection,
            }
          : null;
      this.#fingerprints.set(data, known);
    }
    return known ?? undefined;
  }

  /**
   * Whether `agent` leads on `canvas` now: you made it a lead, it isn't held, and its agent is still
   * what it was then, in the document as the core has it now (none while it isn't loaded).
   */
  isLead(canvas: CanvasId, agent: string): boolean {
    const lead = this.#leads.get(canvas)?.get(agent);
    if (lead === undefined || lead.held !== undefined) return false;
    const node = this.#agentOf(canvas, agent);
    return node !== undefined && this.#changed(lead.fingerprint, node.data) === undefined;
  }

  /** What `agent` may answer for its team while it leads: none while it doesn't. */
  grantsOf(canvas: CanvasId, agent: string): LeadGrants | undefined {
    return this.isLead(canvas, agent) ? this.#leads.get(canvas)?.get(agent)?.grants : undefined;
  }

  /**
   * The canvas's leads, by agent: each one's grants, and what holds it (what changed of its agent
   * since you made it a lead), if anything does.
   */
  view(canvas: CanvasId): LeadView[] {
    const document = this.#deps.document(canvas);
    return [...(this.#leads.get(canvas) ?? [])]
      .flatMap(([agent, lead]): LeadView[] => {
        if (document === undefined)
          return [{ agent, grants: { ...lead.grants }, held: lead.held ?? null }];
        const node = this.#indexOf(document).get(agent);
        if (node === undefined) return [];
        const held = lead.held ?? this.#changed(lead.fingerprint, node.data) ?? null;
        return [{ agent, grants: { ...lead.grants }, held }];
      })
      .sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  }

  /**
   * Makes `agent` a lead on `canvas` with `lead`'s grants, as `lead`'s fingerprint says its agent is
   * now, clearing what held it; or, with null, no lead. On disk once it resolves; rejects, changing
   * nothing, if it couldn't be written. Its caller checked the agent, between the canvas's commits.
   */
  async set(
    canvas: CanvasId,
    agent: string,
    lead: { grants: LeadGrants; fingerprint: Fingerprint } | null,
  ): Promise<void> {
    const { store, memory } = this.#deps;
    const at = this.#now();
    await store.writeBlocking(() => {
      if (lead === null) {
        store.prepare('DELETE FROM lead WHERE canvas_id = ? AND agent_id = ?').run(canvas, agent);
        return;
      }
      memory.ensure(canvas);
      store
        .prepare(
          `INSERT INTO lead (canvas_id, agent_id, grants, fingerprint, held, changed_at)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT (canvas_id, agent_id) DO UPDATE SET grants = excluded.grants,
             fingerprint = excluded.fingerprint, held = NULL, changed_at = excluded.changed_at`,
        )
        .run(
          canvas,
          agent,
          JSON.stringify(grantsRow(lead.grants)),
          JSON.stringify(fingerprintRow(lead.fingerprint)),
          at,
        );
    });
    this.#unread.get(canvas)?.delete(agent);
    if (lead === null) this.#leads.get(canvas)?.delete(agent);
    else
      mapOf(this.#leads, canvas).set(agent, {
        grants: { ...lead.grants },
        fingerprint: lead.fingerprint,
        held: undefined,
      });
    this.#deps.changed?.(canvas, agent);
  }

  /** The token names you let answer approvals on `canvas`, in order. */
  granted(canvas: CanvasId): string[] {
    return [...(this.#grants.get(canvas) ?? [])].sort();
  }

  /** Whether you let the outside orchestrator named `name` answer approvals on `canvas`. */
  isGranted(canvas: CanvasId, name: string): boolean {
    return this.#grants.get(canvas)?.has(name) === true;
  }

  /**
   * Lets the outside orchestrator named `name` answer approvals on `canvas`, or stops letting it:
   * whether that changed anything. On disk once it resolves; rejects, changing nothing, if it
   * couldn't be written.
   */
  async setGrant(canvas: CanvasId, name: string, approvals: boolean): Promise<boolean> {
    if (this.isGranted(canvas, name) === approvals) return false;
    const { store, memory } = this.#deps;
    const at = this.#now();
    await store.writeBlocking(() => {
      if (!approvals) {
        store
          .prepare('DELETE FROM outside_grant WHERE canvas_id = ? AND name = ?')
          .run(canvas, name);
        return;
      }
      memory.ensure(canvas);
      store
        .prepare(
          `INSERT INTO outside_grant (canvas_id, name, changed_at) VALUES (?, ?, ?)
           ON CONFLICT (canvas_id, name) DO UPDATE SET changed_at = excluded.changed_at`,
        )
        .run(canvas, name, at);
    });
    if (approvals) setOf(this.#grants, canvas).add(name);
    else this.#grants.get(canvas)?.delete(name);
    this.#deps.changed?.(canvas);
    return true;
  }

  /**
   * Within a commit's write, whatever made it (Documents' participant): the rows of leads whose
   * agent it removes deleted, and those whose agent's adapter, connection or role it changes held.
   * What it staged is taken in memory once the write is on disk (`reveal`); a failed write keeps
   * nothing of it.
   */
  within(canvas: CanvasId, after: CanvasDocument): Staged | undefined {
    const decided = this.#decide(canvas, after);
    if (decided === undefined) return undefined;
    this.#apply(canvas, decided);
    return {
      reveal: () => {
        this.#take(canvas, decided);
      },
      undo: () => undefined,
    };
  }

  /**
   * A canvas's document loaded (Documents' participant): the rows of agents it doesn't have go,
   * and those whose agent changed since are held, in a write of their own, as a commit would.
   * Rejects, keeping them, if that couldn't be written.
   */
  async loaded(canvas: CanvasId, document: CanvasDocument): Promise<void> {
    const decided = this.#decide(canvas, document);
    if (decided === undefined) return;
    await this.#deps.store.writeBlocking(() => {
      this.#apply(canvas, decided);
    });
    this.#take(canvas, decided);
  }

  /**
   * Drops what this keeps of each canvas the database no longer has (canvas memory forgot it,
   * its rows going with it); of every canvas, where that can't be read: no lead is the narrower.
   */
  #forgotten(): void {
    const canvases = new Set([
      ...this.#leads.keys(),
      ...this.#unread.keys(),
      ...this.#grants.keys(),
    ]);
    if (canvases.size === 0) return;
    try {
      for (const canvas of canvases) if (!this.#deps.memory.keeps(canvas)) this.#drop(canvas);
    } catch {
      for (const canvas of canvases) this.#drop(canvas);
    }
  }

  #drop(canvas: CanvasId): void {
    this.#leads.delete(canvas);
    this.#unread.delete(canvas);
    this.#grants.delete(canvas);
  }

  /** What a document decides of a canvas's leads: the agents gone, and those to hold, with why. */
  #decide(
    canvas: CanvasId,
    document: CanvasDocument,
  ): { gone: string[]; held: [string, HeldReason][] } | undefined {
    const leads = this.#leads.get(canvas);
    const unread = this.#unread.get(canvas);
    if ((leads?.size ?? 0) === 0 && (unread?.size ?? 0) === 0) return undefined;
    const agents = this.#indexOf(document);
    const gone = [...(unread ?? [])].filter((agent) => !agents.has(agent));
    const held: [string, HeldReason][] = [];
    for (const [agent, lead] of leads ?? []) {
      const node = agents.get(agent);
      if (node === undefined) {
        gone.push(agent);
        continue;
      }
      if (lead.held !== undefined) continue;
      const reason = this.#changed(lead.fingerprint, node.data);
      if (reason !== undefined) held.push([agent, reason]);
    }
    return gone.length === 0 && held.length === 0 ? undefined : { gone, held };
  }

  /** Within a write: what was decided, written. */
  #apply(canvas: CanvasId, { gone, held }: { gone: string[]; held: [string, HeldReason][] }): void {
    const { store } = this.#deps;
    for (const agent of gone) {
      store.run('DELETE FROM lead WHERE canvas_id = ? AND agent_id = ?', canvas, agent);
    }
    for (const [agent, reason] of held) {
      store.run(
        'UPDATE lead SET held = ? WHERE canvas_id = ? AND agent_id = ? AND held IS NULL',
        reason,
        canvas,
        agent,
      );
    }
  }

  /** Once it is on disk: what was decided, in memory, and said. */
  #take(canvas: CanvasId, { gone, held }: { gone: string[]; held: [string, HeldReason][] }): void {
    const leads = this.#leads.get(canvas);
    for (const agent of gone) {
      leads?.delete(agent);
      this.#unread.get(canvas)?.delete(agent);
    }
    for (const [agent, reason] of held) {
      const lead = leads?.get(agent);
      if (lead !== undefined) leads?.set(agent, { ...lead, held: reason });
    }
    this.#deps.changed?.(canvas);
  }

  /** What of an agent differs from `fingerprint`: its adapter first, then connection, then role. */
  #changed(fingerprint: Fingerprint, data: AgentData): HeldReason | undefined {
    const now = this.fingerprintOf(data);
    // An endpoint no longer known (unchosen, or what this build lacks) is its adapter changed.
    if (now?.adapter !== fingerprint.adapter) return 'adapter';
    if (now.connection !== fingerprint.connection) return 'connection';
    if (now.role !== fingerprint.role) return 'role';
    return undefined;
  }

  #agentOf(canvas: CanvasId, agent: string): AgentNode | undefined {
    const document = this.#deps.document(canvas);
    return document === undefined ? undefined : this.#indexOf(document).get(agent);
  }

  /** A document's agents by id, indexed once for each document. */
  #indexOf(document: CanvasDocument): ReadonlyMap<string, AgentNode> {
    let agents = this.#agents.get(document);
    if (agents === undefined) {
      agents = new Map(
        document.nodes.flatMap((node) => (node.type === 'agent' ? [[node.id, node] as const] : [])),
      );
      this.#agents.set(document, agents);
    }
    return agents;
  }
}

/** A lead's row as this code reads it: undefined for one it can't (another version's). */
function readLead(row: Record<string, unknown>): Lead | undefined {
  try {
    const grants = JSON.parse(String(row.grants)) as unknown;
    const fingerprint = JSON.parse(String(row.fingerprint)) as unknown;
    const held = row.held;
    if (!isRecord(grants) || grants.v !== 1) return undefined;
    if (
      Object.keys(grants).some(
        (key) => key !== 'v' && !(GRANT_KEYS as readonly string[]).includes(key),
      )
    )
      return undefined;
    if (GRANT_KEYS.some((key) => typeof grants[key] !== 'boolean')) return undefined;
    if (!isRecord(fingerprint) || fingerprint.v !== 1) return undefined;
    const { role, adapter, connection } = fingerprint;
    if (Object.keys(fingerprint).length !== 4) return undefined;
    if (typeof role !== 'string' || !ROLE.test(role)) return undefined;
    if (typeof adapter !== 'string' || adapter === '') return undefined;
    if (typeof connection !== 'string' || connection === '') return undefined;
    if (held !== null && held !== 'adapter' && held !== 'connection' && held !== 'role')
      return undefined;
    return {
      grants: {
        questions: grants.questions === true,
        plans: grants.plans === true,
        approvals: grants.approvals === true,
      },
      fingerprint: { v: 1, role, adapter, connection },
      held: held ?? undefined,
    };
  } catch {
    return undefined;
  }
}

/** Grants as a row keeps them: versioned, in a fixed order. */
function grantsRow(grants: LeadGrants) {
  return { v: 1, questions: grants.questions, plans: grants.plans, approvals: grants.approvals };
}

/** A fingerprint as a row keeps it, in a fixed order. */
function fingerprintRow({ role, adapter, connection }: Fingerprint) {
  return { v: 1, role, adapter, connection };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapOf<K, V>(maps: Map<CanvasId, Map<K, V>>, canvas: CanvasId): Map<K, V> {
  let map = maps.get(canvas);
  if (map === undefined) maps.set(canvas, (map = new Map<K, V>()));
  return map;
}

function setOf<V>(sets: Map<CanvasId, Set<V>>, canvas: CanvasId): Set<V> {
  let set = sets.get(canvas);
  if (set === undefined) sets.set(canvas, (set = new Set<V>()));
  return set;
}
