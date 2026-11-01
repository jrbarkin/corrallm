import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ConnectionId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import { CORRALLM_AGENT_MCP_SERVER, CORRALLM_MCP_SERVER } from '../../shared/session';
import { callTool, listTools } from '../api/mcp';
import type { AgentChannel, SessionApi, ToolGrant } from '../sessions/connector';
import type { Dispatcher } from './call';
import type { AgentCaller } from './caller';

/*
 * The session authority (B21 Design §9 C1, C2): the one issuer of the credentials corrallm's own
 * agents call its MCP server with. Each agent's session generation gets at most one, minted by
 * `issue` as SessionManager launches it (after its folder is admitted and its conversation
 * claimed, before its connector starts), for a connection whose descriptor declares an `api` route
 * while the profile's endpoint listens; nothing else mints one. Over http it is 32 random bytes
 * (base64url), never derived from an id, of which the authority keeps only the SHA-256 hash, mapped
 * to the generation's caller: the plaintext goes once into the session's spec, for its connector
 * alone. Over the in-process channel there is no credential at all: the channel is bound to the
 * caller as it is made. Either way the generation's caller (`AgentCaller`: its canvas, agent,
 * generation and a fresh session UUID, for logs) is the identity; nothing a call's body says is.
 *
 * A caller is current while its entry stands, its generation is the agent's session's now
 * (SessionManager.generationOf) and its agent is on the canvas: so a reused agent id never inherits
 * an old generation's. core.call stamps every agent caller with `current` inside each audience
 * check. An entry stands from `issue` (a CLI lists its tools as it starts) until its session's
 * close begins: SessionManager revokes it beside every end of a generation's prompts, synchronously
 * and idempotently. Entries live in memory only, one per live or starting generation, deleted at
 * revoke: a core that stops ends them all.
 *
 * The core marks a generation listed when it hears that generation list corrallm's tools (an http
 * `tools/list` with its credential, which api/mcp.ts reports; the channel's `list()`): `agents`
 * reports it as an agent's `api`, observed, never claimed by an adapter.
 */

export interface AgentApi {
  /**
   * The route for generation `generation` of the agent's session, which SessionManager puts in
   * its spec: undefined (issuing nothing) for a connection whose descriptor says null, while the
   * endpoint isn't listening, or for a generation that isn't the agent's session now.
   */
  issue(origin: {
    canvas: CanvasId;
    agent: string;
    generation: number;
    connection: ConnectionId;
  }): SessionApi | undefined;
  /** Ends a generation's credential, at once; again, nothing. Beside every `prompts.gone`. */
  revoke(canvas: CanvasId, agent: string, generation: number): void;
  /** The current caller a credential names (by its SHA-256), for the endpoint's lookup. */
  lookup(token: string): AgentCaller | undefined;
  /** Its generation listed corrallm's tools (heard over http, or the channel's `list()`). */
  listed(caller: AgentCaller): void;
  /** Whether a caller still holds its session's authority. */
  current(caller: AgentCaller): boolean;
}

export interface AgentApiDeps {
  /** The route each connection's descriptor declares for corrallm's agent API: null, none. */
  route: (connection: ConnectionId) => 'http' | 'channel' | null;
  /** Where the profile's MCP server listens now: undefined while it doesn't. */
  url: () => string | undefined;
  /** The core's operations, which a generation's tools are listed from and its calls go through. */
  core: () => Dispatcher;
  /** The generation of the agent's session running (or starting) now. */
  generationOf: (canvas: CanvasId, agent: string) => number | undefined;
  /** Whether the agent is on the canvas now. */
  onCanvas: (canvas: CanvasId, agent: string) => boolean;
}

/** The outside registrations a session switches off for itself: orchestrators' names (C3). */
export const OUTSIDE_SERVERS: readonly string[] = [
  CORRALLM_MCP_SERVER,
  `${CORRALLM_MCP_SERVER}-dev`,
];

/** What a credential looks like: 32 bytes, in base64url. */
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

/** A generation's entry: its caller, its credential's hash (none for a channel), and whether it listed. */
interface Entry {
  readonly caller: AgentCaller;
  readonly hash: string | undefined;
  listed: boolean;
}

export class SessionAuthority implements AgentApi {
  readonly #deps: AgentApiDeps;
  /** Each live generation's entry, by its canvas, agent and generation. */
  readonly #entries = new Map<string, Entry>();
  /** The same entries, by their credential's SHA-256 (in hex). */
  readonly #byHash = new Map<string, Entry>();

  constructor(deps: AgentApiDeps) {
    this.#deps = deps;
  }

  issue({
    canvas,
    agent,
    generation,
    connection,
  }: Parameters<AgentApi['issue']>[0]): SessionApi | undefined {
    const route = this.#deps.route(connection);
    if (route === null) return undefined;
    // No endpoint, no API: the session starts without corrallm's server.
    const url = this.#deps.url();
    if (url === undefined) return undefined;
    if (
      this.#deps.generationOf(canvas, agent) !== generation ||
      !this.#deps.onCanvas(canvas, agent)
    ) {
      return undefined;
    }
    // One credential per generation: one issued again replaces it.
    this.revoke(canvas, agent, generation);
    const caller: AgentCaller = Object.freeze({
      kind: 'agent',
      canvas,
      agent,
      generation,
      session: randomUUID(),
    });
    const tools = this.#tools(caller);
    const off = [...OUTSIDE_SERVERS];
    if (route === 'channel') {
      this.#entries.set(keyOf(canvas, agent, generation), {
        caller,
        hash: undefined,
        listed: false,
      });
      return {
        kind: 'channel',
        server: CORRALLM_AGENT_MCP_SERVER,
        tools,
        off,
        channel: this.#channel(caller),
      };
    }
    const token = randomBytes(32).toString('base64url');
    const entry: Entry = { caller, hash: sha256(token), listed: false };
    this.#entries.set(keyOf(canvas, agent, generation), entry);
    this.#byHash.set(sha256(token), entry);
    return { kind: 'http', server: CORRALLM_AGENT_MCP_SERVER, url, token, tools, off };
  }

  revoke(canvas: CanvasId, agent: string, generation: number): void {
    const key = keyOf(canvas, agent, generation);
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    if (entry.hash !== undefined) this.#byHash.delete(entry.hash);
  }

  lookup(token: string): AgentCaller | undefined {
    if (!CREDENTIAL.test(token)) return undefined;
    const entry = this.#byHash.get(sha256(token));
    return entry !== undefined && this.current(entry.caller) ? entry.caller : undefined;
  }

  listed(caller: AgentCaller): void {
    if (!this.current(caller)) return;
    const entry = this.#entries.get(keyOf(caller.canvas, caller.agent, caller.generation));
    if (entry !== undefined) entry.listed = true;
  }

  current(caller: AgentCaller): boolean {
    const { canvas, agent, generation, session } = caller;
    const entry = this.#entries.get(keyOf(canvas, agent, generation));
    return (
      entry?.caller.session === session &&
      this.#deps.generationOf(canvas, agent) === generation &&
      this.#deps.onCanvas(canvas, agent)
    );
  }

  /** Whether the agent's session now has listed corrallm's tools: `agents`' `api`. */
  hasListed(canvas: CanvasId, agent: string): boolean {
    const generation = this.#deps.generationOf(canvas, agent);
    if (generation === undefined) return false;
    const entry = this.#entries.get(keyOf(canvas, agent, generation));
    return entry?.listed === true && this.current(entry.caller);
  }

  /** What it keeps, for tests: how many entries, and each one's hash and caller (never a credential). */
  inspect(): {
    entries: number;
    kept: readonly { hash: string | undefined; caller: AgentCaller }[];
  } {
    return {
      entries: this.#entries.size,
      kept: [...this.#entries.values()].map(({ hash, caller }) => ({ hash, caller })),
    };
  }

  /** The tools the caller's party lists now, by exact MCP name: what its session pre-approves. */
  #tools(caller: AgentCaller): ToolGrant[] {
    return listTools(this.#deps.core(), caller).map(({ name, annotations }) => ({
      name,
      destructive: annotations.destructiveHint,
    }));
  }

  /** The in-process route bound to `caller`, as long as its generation's entry stands. */
  #channel(caller: AgentCaller): AgentChannel {
    return agentChannel(this.#deps.core, caller, {
      current: () => this.current(caller),
      listed: () => {
        this.listed(caller);
      },
    });
  }
}

/**
 * The in-process route bound to `caller`: MCP's list and call (api/mcp.ts' `listTools` and
 * `callTool`), as that caller alone, so it answers as HTTP does. A caller no longer `current` lists
 * nothing; its calls are refused by core.call's own stamp.
 */
export function agentChannel(
  core: () => Dispatcher,
  caller: AgentCaller,
  hooks: { current: () => boolean; listed: () => void },
): AgentChannel {
  return {
    list: () => {
      if (!hooks.current()) return [];
      hooks.listed();
      return listTools(core(), caller);
    },
    call: (name, args, signal) => callTool(core(), caller, name, args, signal),
  };
}

function keyOf(canvas: CanvasId, agent: string, generation: number): string {
  return JSON.stringify([canvas, agent, generation]);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
