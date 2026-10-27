import { adapterIn } from '../../shared/adapter';
import type { AdapterId, Catalog } from '../../shared/adapter';
import { MAX_MESSAGE_BYTES } from '../../shared/api/limits';
import type { ArgsOf } from '../../shared/api/registry';
import { RULES } from '../../shared/api/rules';
import { SURFACE } from '../../shared/api/surface';
import type { OpName, Party, Rule, Surface } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import type { Run } from './engine/run/runner';
import type { PartyId } from '../../shared/model/messages';
import type { AgentNode, CanvasDocument } from '../../shared/model/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { isApproval, isIf, isRepeat } from '../../shared/model/queue';
import type { QueueItem } from '../../shared/model/queue';
import { entityOf, itemKey, nodeKey } from '../../shared/model/rows';
import type { EntityKey, ItemRow, LinkRow, NodeRow } from '../../shared/model/rows';
import { andList } from '../../shared/model/words';
import { CORRALLM_MCP_SERVER, CORRALLM_AGENT_MCP_SERVER } from '../../shared/session';
import type { AgentSettings } from '../../shared/session';
import type { RuleOutcome } from './call';
import type { ChangeSet } from './canvas/change';
import type { ChangeRule } from './canvas/commit';
import { partyIdOf } from './caller';
import type { TokenCaller } from './caller';
import type { Engines } from './engines';
import { nameOf, partyText, pausesText, RELEASES } from './parties';
import { resumeUndoes, startUndoes, usageGoOn } from './run-control';

/*
 * How the core checks the rules that narrow what a token may do (Core Server §3.6): each rule an
 * operation carries on a token's arguments, in the op's scope before it runs (one check per RULES
 * row checked on arguments, for each op that carries it); and each rule checked on the change a
 * token's op commits, whatever op made it (canvas/commit.ts). A rule met refuses the token, saying
 * why; you are never checked.
 */

/** The most agents a refusal names, then how many more there are. */
const NAMED = 5;

/** The rules RULES checks on arguments. */
type ArgumentRule = {
  [R in keyof typeof RULES]: (typeof RULES)[R]['kind'] extends 'change' ? never : R;
}[keyof typeof RULES];

/** The rules RULES checks on the change an op commits. */
type ChangeRuleOf = {
  [R in keyof typeof RULES]: (typeof RULES)[R]['kind'] extends 'argument' ? never : R;
}[keyof typeof RULES];

/**
 * Each rule checked on a token's change: its check, run at every commit of a token's. The compiler
 * refuses a RULES row checked on changes without one, but workspace-safety's, which is checked on
 * everyone's (canvas/commit.ts' `workspaceSafety` and workspaces/planner.ts' `unsafeStep`).
 */
export type ChangeChecks = Partial<Record<Exclude<Rule, 'workspace-safety'>, ChangeRule>> &
  Record<Exclude<ChangeRuleOf, 'workspace-safety'>, ChangeRule>;

/** The rules op `N` carries. */
type RulesOf<N extends OpName> = (typeof SURFACE)[N] extends {
  readonly rules: readonly (infer R)[];
}
  ? R
  : never;

/** The ops that carry rule `R`. */
type Carrying<R> = { [N in OpName]: R extends RulesOf<N> ? N : never }[OpName];

/** Each rule checked on arguments: its check of each op's arguments that carries it. */
export type ArgumentChecks = {
  [R in ArgumentRule]: {
    [N in Carrying<R>]: (
      args: ArgsOf<N>,
      call: { caller: TokenCaller; party: Party },
    ) => RuleOutcome | Promise<RuleOutcome>;
  };
};

/**
 * Q30 (B9b §9 C1): only a token made to merge merges an agent's branch. A token made with
 * --no-merge is a writer that may not, a read-only one never may, and no agent may (none is in
 * branch.merge's audience in B9b: whether a lead merges its team's branches is B24's to decide,
 * here too). It reads only who calls, never the call's arguments.
 */
export function mergePermits(caller: TokenCaller): RuleOutcome {
  if (caller.kind === 'outside') {
    return caller.merge ? undefined : { refuse: RULES['merge-permits'].sentence };
  }
  return { refuse: 'An agent can’t merge a branch: only the user, or a token made to.' };
}

/** A rule's check that reads only who calls, whatever the op's arguments. */
type CallerCheck = (
  args: unknown,
  call: { caller: TokenCaller; party: Party },
) => RuleOutcome | Promise<RuleOutcome>;

/**
 * `check` on every op of `surface` (the registry's) that carries `rule`: for a rule that reads
 * only who calls, so that an op is guarded from the moment it carries it.
 */
export function onEveryCarrier<R extends ArgumentRule>(
  rule: R,
  check: CallerCheck,
  surface: Readonly<Record<string, Surface>> = SURFACE,
): ArgumentChecks[R] {
  return Object.fromEntries(
    Object.entries(surface)
      .filter(([, op]) => op.rules?.includes(rule) === true)
      .map(([name]) => [name, check]),
  ) as ArgumentChecks[R];
}

/**
 * The rules checked on a token's arguments, over the canvases the core runs (`engines`) and what
 * waits for an answer on each, as you see it (`needOf`: an item by its id). R4's (`discard`), on a
 * canvas's lifetime, are its ops' own (ops/files.ts).
 */
export function ruleChecks(
  engines: Engines,
  needOf: (canvas: CanvasId, id: string) => NeedsItem | undefined = () => undefined,
): Omit<ArgumentChecks, 'discard' | 'restore-code'> {
  /** The open canvas a call names, if it is open. */
  const openOf = (canvas: string | undefined) =>
    canvas === undefined ? undefined : engines.canvas(canvas as CanvasId);
  return {
    // Q30: the same check on every op that carries the rule (branch.merge, once registered).
    'merge-permits': onEveryCarrier('merge-permits', (_args, { caller }) => mergePermits(caller)),
    // R3: the caller must be one the item names to answer it now (its `by`), and may pick no
    // choice only you may (`humanOnly`). An item that isn't there is the op's to say.
    'human-choice': {
      reply: ({ canvas, to, answer }, { caller }) => {
        const item = canvas === undefined ? undefined : needOf(canvas as string as CanvasId, to);
        if (item === undefined) return undefined;
        // R6 first: what waits on an agent is never that agent's to answer, whoever `by` names.
        if (
          caller.kind === 'agent' &&
          (caller.canvas as string) === (canvas as string | undefined) &&
          item.agent === caller.agent
        ) {
          return { refuse: `An agent never answers what waits on itself: ${item.title}.` };
        }
        if (!item.by.includes(partyIdOf(caller))) {
          return {
            refuse: `Only ${andList(item.by.map((party) => partyText([], party)))} may answer this: ${item.title}.`,
          };
        }
        // A typed answer (B11 C7's prepared reply) picks a choice too: a permission's, say.
        const typed = answer as { choice?: string; permission?: string };
        const chosen = typed.choice ?? typed.permission;
        const choice = item.choices.find(({ value }) => value === chosen);
        return choice?.humanOnly === undefined
          ? undefined
          : { refuse: `Only the user may choose ${choice.label}: ${choice.humanOnly}` };
      },
      // Go on past a usage rule's hold lets every agent on its backend go on: yours alone.
      'run.goOn': ({ canvas, agent, item }) => {
        const open = openOf(canvas);
        const refusal = open && usageGoOn(open, agent, item);
        return refusal === undefined ? undefined : { refuse: refusal };
      },
    },
    // R1: only what you typed may run a shell command, and a body that starts with its recipient's
    // shell prefix would (src/shared/adapter.ts ConnectionDescriptor.shellPrefix).
    'shell-text': {
      message: ({ canvas, to, body }) => {
        const open = openOf(canvas);
        const node = open?.document.nodes.find((one) => one.id === to);
        if (!open || node?.type !== 'agent') return undefined;
        const { catalog } = open.engine;
        const connection = catalog.connectionOf(node.data);
        const prefix = catalog.shellPrefix(connection);
        if (prefix === undefined || prefix === '' || !body.trimStart().startsWith(prefix)) {
          return undefined;
        }
        return {
          refuse: `It starts with "${prefix}", which ${catalog.connectionName(connection) ?? 'its connection'} runs as a shell command without asking: only the user may send that.`,
        };
      },
    },
    // B11 §16.6: past 16 KiB of text, or with images, a message is your composer's alone; a
    // token's is refused, never cut or stripped.
    'human-text': {
      message: ({ body, images }) =>
        new TextEncoder().encode(body).length > MAX_MESSAGE_BYTES || (images?.length ?? 0) > 0
          ? { refuse: RULES['human-text'].sentence }
          : undefined,
    },
    'corral-mcp': {
      'session.changeMcpServer': ({ server }) =>
        server === CORRALLM_MCP_SERVER || server === CORRALLM_AGENT_MCP_SERVER
          ? { refuse: RULES['corral-mcp'].sentence }
          : undefined,
    },
    // R2's argument half: a mode other than the one saved for that adapter, or none while one is.
    // Leaving it out, or passing the saved one, keeps it.
    'mode-permits': {
      'agent.setSettings': ({ canvas, agent, adapter, settings }) => {
        if (settings.mode === undefined) return undefined;
        const nodes = openOf(canvas)?.document.nodes ?? [];
        const node = nodes.find((one) => one.id === agent);
        if (node?.type !== 'agent') return undefined;
        const saved = node.data.settings?.[adapter]?.mode;
        if ((settings.mode ?? undefined) === saved) return undefined;
        return {
          refuse:
            saved === undefined
              ? `${nameOf(nodes, agent)} starts in the user’s own default mode for ${adapter}: only the user sets it another. Leave mode out.`
              : `${nameOf(nodes, agent)} starts in ${saved} on ${adapter}: only the user changes that. Leave mode out, or pass "${saved}".`,
        };
      },
      // Each of its ops is checked as it is prepared, as a call of its own: agent.setSettings's
      // check above among them.
      'canvas.batch': () => undefined,
    },
    // R9: a token releases only the pauses its own party set; yours (and others') stay. One whose
    // own release would let go of nothing that holds the target is refused, saying who holds it:
    // its own pause on a group the target is in, released on that group, first.
    sticky: {
      'run.unpause': ({ canvas, target }, { caller }) => {
        const open = openOf(canvas);
        if (!open) return undefined;
        const { run } = open.engine;
        const holding = run.holding(target);
        const party = partyIdOf(caller);
        if (holding.length === 0 || run.pausedBy(target).includes(party)) return undefined;
        const { nodes } = open.document;
        const id = 'agent' in target ? target.agent : target.group;
        const own = holding.filter(({ by }) => by === party);
        const others = holding.filter(({ by }) => by !== party);
        const othersText = `paused by ${pausesText(nodes, id, others)}: ${RELEASES}`;
        if (own.length === 0) return { refuse: `${nameOf(nodes, id)} stays ${othersText}` };
        const names = andList(own.map(({ id: on }) => `"${nameOf(nodes, on)}"`));
        const [pauses, groups, them, those] =
          own.length === 1
            ? ['pause', 'group', 'it', 'that group']
            : ['pauses', 'groups', 'them', 'those groups'];
        return {
          refuse:
            `${nameOf(nodes, id)} is held by your ${pauses} on its ${groups} ${names}: release ${them} with run.unpause on ${those}.` +
            (others.length === 0 ? '' : ` It is also ${othersText}`),
        };
      },
      // Nor resumes a run another party stopped (you, over any other), nor starts one afresh past
      // another's stop, decisions or what it holds for you (run-control.ts).
      'run.resume': ({ canvas }, { caller }) => {
        const open = openOf(canvas);
        const refusal = open && resumeUndoes(open, caller);
        return refusal === undefined ? undefined : { refuse: refusal };
      },
      'run.start': ({ canvas }, { caller }) => {
        const open = openOf(canvas);
        const refusal = open && startUndoes(open, caller);
        return refusal === undefined ? undefined : { refuse: refusal };
      },
    },
  };
}

/** What the change rules read besides the change: how agents run, and what the run holds. */
export interface ChangeCheckDeps {
  catalog: Catalog;
  /** The adapter an agent naming none runs. */
  defaultAdapter: AdapterId;
  /** The items a canvas's run holds for you now, by their keys (heldBy). */
  held: (canvas: CanvasId) => ReadonlySet<EntityKey>;
  /** How many live agents `party` created: on `canvas`, or on every canvas the core keeps. */
  created: (
    party: PartyId,
    canvas?: CanvasId,
    removing?: Pick<ChangeSet, 'canvas' | 'removed'>,
  ) => number;
  /** The most live agents a token's party may have created (R11): MAX_CREATED_AGENTS. */
  maxCreated: () => number;
}

/**
 * The items `run` holds for you (B9 Design §4): each agent's task while it asks you (an OK waiting,
 * a condition for your yes or no, a task's problem, a session that won't start, a usage rule's
 * question), from where each agent is, paused or not (never heldAsks, which a paused run holds
 * none of), by its key.
 */
export function heldBy(run: Run | undefined): Set<EntityKey> {
  return new Set(
    Object.entries(run?.agents ?? {}).flatMap(([agent, at]) =>
      at.status === 'asking' && at.current !== undefined ? [itemKey(agent, at.current)] : [],
    ),
  );
}

/**
 * Each rule checked on the change a token's op commits, whatever op made it (B9 Design §4): on the
 * agents it kept, that existed before it, unless a rule says otherwise. The first that refuses says
 * why, naming what it would change.
 */
export function changeChecks({
  catalog,
  defaultAdapter,
  held,
  created,
  maxCreated,
}: ChangeCheckDeps): ChangeChecks {
  /** The adapter and the connection an agent runs: its adapter's first, if it names none. */
  const runs = (row: Pick<NodeRow, 'adapter' | 'connection'>): [AdapterId, string | undefined] => {
    const adapter = row.adapter ?? defaultAdapter;
    return [adapter, row.connection ?? adapterIn(catalog, adapter)?.connections[0]?.id];
  };
  return {
    // R4: deleting an agent is yours to decide: a token's delete comes to you as a proposal, unless
    // another rule refuses it.
    discard: (change) => {
      if (change.removed.size === 0) return undefined;
      const names = change.before.nodes.flatMap((node) =>
        change.removed.has(node.id) ? [nameOf(change.before.nodes, node.id)] : [],
      );
      const more = names.length - NAMED;
      return {
        propose: `Only the user deletes ${andList(more > 0 ? [...names.slice(0, NAMED), `${String(more)} more`] : names)}`,
      };
    },
    // R6: an agent never changes its own role, settings, adapter, connection or manager, nor
    // removes itself, whatever op would (its declared half, `self`, refuses one naming itself).
    self: (change, { caller }) => {
      if (caller.kind !== 'agent' || caller.canvas !== change.canvas) return undefined;
      const self = caller.agent;
      const name = nameOf(change.before.nodes, self);
      if (change.removed.has(self)) {
        return { refuse: `An agent never removes itself: this would remove ${name}.` };
      }
      const manager = change.manager.get(self);
      if (manager) {
        return {
          refuse: `An agent never changes its own manager: this would put ${name} ${managed(change, manager[1])}.`,
        };
      }
      const entity = change.entities.get(nodeKey(self));
      const [was, is] = [entity?.before as NodeRow | null, entity?.after as NodeRow | null];
      if (!was || !is) return undefined;
      const changed = (
        [
          ['role', (was.role ?? '') !== (is.role ?? '')],
          ['settings', !sameSettings(was.settings, is.settings)],
          ['adapter or connection', runs(was).join() !== runs(is).join()],
        ] as const
      ).find(([, differs]) => differs);
      return (
        changed && {
          refuse: `An agent never changes its own ${changed[0]}: this would change ${name}’s.`,
        }
      );
    },
    // R2: the mode an agent that existed starts in, under any adapter's settings.
    'mode-permits': (change) => {
      for (const [id, was, is] of keptAgents(change)) {
        const adapter = changedMode(was.settings, is.settings);
        if (adapter === undefined) continue;
        return {
          refuse: `Only the user changes the mode ${nameOf(change.before.nodes, id)} starts in (its ${adapter} settings): leave mode out, or pass the saved one.`,
        };
      }
      return undefined;
    },
    // R7, as strict as revision R34 (B9 Design §12): an OK, held or not, or an item the run holds
    // for you, removed or changed; an agent removed whose queue holds one; or work moved past one,
    // either way. (Which of two items moved, a change can't say: an OK moved up past work is that
    // work moved down past it.) An OK, and work after one, may be added.
    'human-gate': (change) => {
      const holds = held(change.canvas);
      const gated = (agent: string) => (item: QueueItem) =>
        isApproval(item) || holds.has(itemKey(agent, item.id));
      for (const id of change.removed) {
        const item = itemsOf(queueOf(change.before, id) ?? []).find(gated(id));
        if (item === undefined) continue;
        return {
          refuse: `Only the user deletes ${nameOf(change.before.nodes, id)}: its queue holds ${gatedText(item)} (${item.id}).`,
        };
      }
      for (const [key, { before, after }] of change.entities) {
        if (entityOf(key) !== 'item' || before === null) continue;
        const [was, is] = [before as ItemRow, after as ItemRow | null];
        if (was.kind !== 'approval' && !holds.has(key)) continue;
        // Its place alone: whether work crossed it is read below.
        if (is !== null && is.container === was.container && sameJson(is.body, was.body)) continue;
        return {
          refuse: `Only the user ${is === null ? 'removes' : 'changes'} ${was.kind === 'approval' ? 'an OK' : 'what the run holds for them'} (${was.id} in ${nameOf(change.before.nodes, was.agent)}’s queue).`,
        };
      }
      const touched = new Set(
        [...change.entities].flatMap(([key, { before, after }]) =>
          entityOf(key) === 'item' ? [((after ?? before) as ItemRow).agent] : [],
        ),
      );
      for (const agent of touched) {
        const was = queueOf(change.before, agent);
        const is = queueOf(change.after, agent);
        const crossed = was && is && crossing(was, is, gated(agent));
        if (!crossed) continue;
        return {
          refuse: `Only the user moves work past ${gatedText(crossed.gate)} (${crossed.gate.id}): ${crossed.item} would come ${crossed.ahead ? 'before' : 'after'} it in ${nameOf(change.before.nodes, agent)}’s queue.`,
        };
      }
      return undefined;
    },
    // R8: how an agent that existed runs, its adapter or its connection.
    connection: (change) => {
      for (const [id, was, is] of keptAgents(change)) {
        if (runs(was).join() === runs(is).join()) continue;
        const [from, to] = [runs(was), runs(is)].map(
          ([adapter, connection]) => connection ?? adapter,
        );
        return {
          refuse: `Only the user changes how ${nameOf(change.before.nodes, id)} runs (${String(from)}, not ${String(to)}): its adapter and connection are theirs to choose.`,
        };
      }
      return undefined;
    },
    // R11: a new agent runs as its adapter's first connection does, in its user's own default
    // mode, unless it copies the agent it was spawned from; and its party keeps at most
    // maxCreated() live agents it created: an outside party across every canvas, an agent on its
    // own (B9 Design §12). Copies count; agents you create count toward no one.
    'new-agent': (change, { caller }) => {
      for (const id of change.created) {
        const node = change.after.nodes.find((one) => one.id === id);
        if (node?.type !== 'agent') continue;
        const source = copiedFrom(change, id);
        const name = nameOf(change.after.nodes, id);
        const adapter = node.data.adapter ?? defaultAdapter;
        const first = adapterIn(catalog, adapter)?.connections[0]?.id;
        if (
          node.data.connection !== undefined &&
          node.data.connection !== first &&
          (source === undefined || runs(node.data).join() !== runs(source.data).join())
        ) {
          return {
            refuse: `A token’s new agent runs on its adapter’s first connection, ${first ?? adapter}: only the user runs ${name} on ${node.data.connection}.`,
          };
        }
        const moded = Object.entries(node.data.settings ?? {}).find(
          ([adapter, one]) =>
            one?.mode !== undefined && one.mode !== source?.data.settings?.[adapter]?.mode,
        );
        if (moded) {
          return {
            refuse: `A token’s new agent starts in its user’s own default mode: only the user starts ${name} in ${String(moded[1]?.mode)}.`,
          };
        }
      }
      if (change.created.size === 0) return undefined;
      const most = maxCreated();
      const everywhere = caller.kind === 'outside';
      const live = created(change.by, everywhere ? undefined : change.canvas, change);
      if (live + change.created.size <= most) return undefined;
      return {
        refuse: `${partyText(change.before.nodes, change.by)} keeps at most ${String(most)} live agents it created ${everywhere ? 'across its canvases' : 'on its canvas'}, and has ${String(live)}: only the user adds more, unless one of them is deleted.`,
      };
    },
    // R12: the role of an agent that existed. One created in the same change may be given one.
    role: (change) => {
      for (const [id, was, is] of keptAgents(change)) {
        if ((was.role ?? '') === (is.role ?? '')) continue;
        return {
          refuse: `Only the user changes ${nameOf(change.before.nodes, id)}’s role: a token gives a role only to an agent it creates in the same change.`,
        };
      }
      return undefined;
    },
    // R13: a link added or removed between agents that both existed and both remain. Removing an
    // agent's links by deleting it is a deletion.
    links: (change) => {
      const remains = (id: string) =>
        change.after.nodes.some((node) => node.id === id && node.type === 'agent');
      for (const [key, { before, after }] of change.entities) {
        if (entityOf(key) !== 'link' || (before === null) === (after === null)) continue;
        const { a, b } = (after ?? before) as LinkRow;
        if (![a, b].every((end) => change.existed(end) && remains(end))) continue;
        const names = `${nameOf(change.before.nodes, a)} and ${nameOf(change.before.nodes, b)}`;
        return {
          refuse: `Only the user ${after ? 'links' : 'unlinks'} ${names}, which both exist: a token links only an agent it creates.`,
        };
      }
      return undefined;
    },
    // R14: who manages an agent that existed (the nearest agent it is nested in), as an agent
    // made around it, of a frame holding it, or taken out of one would change it, or its manager's
    // removal. Frames are free.
    managers: (change) => {
      const [first] = change.manager;
      if (!first) return undefined;
      const [id, [was, is]] = first;
      return {
        refuse: `Only the user changes who manages ${nameOf(change.before.nodes, id)}, ${was === null ? 'which no agent manages' : `managed by ${nameOf(change.before.nodes, was)}`}: this would put it ${managed(change, is)}. A frame around agents changes no manager.`,
      };
    },
  };
}

/**
 * A copy's source as it existed, or another new agent it copied. Follow new-copy chains to ensure
 * they end at an actual source, never a missing source or a cycle of invented exemptions. Each
 * new source is itself checked by R11; only the permission fields that match it are inherited.
 */
function copiedFrom(change: ChangeSet, id: string): AgentNode | undefined {
  const seen = new Set([id]);
  let from = change.copies.get(id);
  let source: AgentNode | undefined;
  while (from !== undefined) {
    if (seen.has(from)) return undefined;
    seen.add(from);
    const before = change.before.nodes.find((node) => node.id === from && node.type === 'agent');
    const node = before ?? change.after.nodes.find((node) => node.id === from);
    if (node?.type !== 'agent') return undefined;
    source ??= node;
    if (before !== undefined) return source;
    from = change.copies.get(from);
  }
  return source;
}

/** Each agent a change kept that existed before it and was changed: its node row then and now. */
function keptAgents(change: ChangeSet): [string, NodeRow, NodeRow][] {
  const kept: [string, NodeRow, NodeRow][] = [];
  for (const [key, { before, after }] of change.entities) {
    if (entityOf(key) !== 'node') continue;
    const [was, is] = [before as NodeRow | null, after as NodeRow | null];
    if (was?.kind === 'agent' && is?.kind === 'agent') kept.push([is.id, was, is]);
  }
  return kept;
}

/** Agent `id`'s queue in `document`, if it is an agent there. */
function queueOf(document: CanvasDocument, id: string): readonly QueueItem[] | undefined {
  const node = document.nodes.find((one) => one.id === id);
  return node?.type === 'agent' ? (node.data.queue ?? []) : undefined;
}

/** A queue's items, at any depth: each if-then's and repeat's after it. */
function itemsOf(queue: readonly QueueItem[]): QueueItem[] {
  return queue.flatMap((item) => [
    item,
    ...(isIf(item) ? item.then : isRepeat(item) ? item.repeat : []),
  ]);
}

/** What a gated item is, as a refusal says it. */
function gatedText(item: QueueItem): string {
  return isApproval(item) ? 'an OK' : 'what the run holds for the user';
}

/**
 * The first item a queue's change moved past a gated item it kept (one `gated` before), either way,
 * at any depth: whether it now comes ahead of it.
 */
function crossing(
  was: readonly QueueItem[],
  is: readonly QueueItem[],
  gated: (item: QueueItem) => boolean,
): { item: string; gate: QueueItem; ahead: boolean } | undefined {
  const order = (queue: readonly QueueItem[]) =>
    new Map(itemsOf(queue).map((item, at) => [item.id, at]));
  const [before, after] = [order(was), order(is)];
  for (const gate of itemsOf(was).filter(gated)) {
    const [then, now] = [before.get(gate.id), after.get(gate.id)];
    if (then === undefined || now === undefined) continue;
    for (const [item, at] of after) {
      const prior = before.get(item);
      if (prior === undefined || item === gate.id || prior < then === at < now) continue;
      return { item, gate, ahead: at < now };
    }
  }
  return undefined;
}

/** Whether two plain values are the same, as JSON says them. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Where a change puts an agent, as its manager says it: under an agent, or under none. */
function managed(change: ChangeSet, manager: string | null): string {
  return manager === null ? 'under no agent' : `under ${nameOf(change.after.nodes, manager)}`;
}

type Settings = Partial<Record<AdapterId, AgentSettings>> | undefined;

/** The first adapter whose saved mode differs between two settings, if one does. */
function changedMode(was: Settings, is: Settings): AdapterId | undefined {
  const adapters = new Set([...Object.keys(was ?? {}), ...Object.keys(is ?? {})]);
  return [...adapters].find((adapter) => was?.[adapter]?.mode !== is?.[adapter]?.mode);
}

/** Whether two settings set the same, field by field, under each adapter. */
function sameSettings(was: Settings, is: Settings): boolean {
  const adapters = new Set([...Object.keys(was ?? {}), ...Object.keys(is ?? {})]);
  return [...adapters].every((adapter) =>
    (['model', 'effort', 'mode'] as const).every(
      (field) => was?.[adapter]?.[field] === is?.[adapter]?.[field],
    ),
  );
}
