import { adapterIn } from '../../shared/adapter';
import type { AdapterId, Catalog } from '../../shared/adapter';
import type { ArgsOf } from '../../shared/api/registry';
import type { RULES } from '../../shared/api/rules';
import type { OpName, Party, Rule, SURFACE } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { entityOf, nodeKey } from '../../shared/model/rows';
import type { LinkRow, NodeRow } from '../../shared/model/rows';
import { andList } from '../../shared/model/words';
import type { AgentSettings } from '../../shared/session';
import type { RuleOutcome } from './call';
import type { ChangeSet } from './canvas/change';
import type { ChangeRule } from './canvas/commit';
import { partyIdOf } from './caller';
import type { TokenCaller } from './caller';
import type { Engines } from './engines';
import { nameOf, pausesText, RELEASES } from './parties';

/*
 * How the core checks the rules that narrow what a token may do (Core Server §3.6): each rule an
 * operation carries on a token's arguments, in the op's scope before it runs (one check per RULES
 * row checked on arguments, for each op that carries it); and each rule checked on the change a
 * token's op commits, whatever op made it (canvas/commit.ts). A rule met refuses the token, saying
 * why; you are never checked.
 */

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
 * refuses a RULES row checked on changes without one.
 */
export type ChangeChecks = Partial<Record<Rule, ChangeRule>> & Record<ChangeRuleOf, ChangeRule>;

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

export function ruleChecks(engines: Engines): ArgumentChecks {
  /** The open canvas a call names, if it is open. */
  const openOf = (canvas: string | undefined) =>
    canvas === undefined ? undefined : engines.canvas(canvas as CanvasId);
  return {
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
    },
  };
}

/** What the change rules read besides the change: how agents run. */
export interface ChangeCheckDeps {
  catalog: Catalog;
  /** The adapter an agent naming none runs. */
  defaultAdapter: AdapterId;
}

/**
 * Each rule checked on the change a token's op commits, whatever op made it (B9 Design §4): on the
 * agents it kept, that existed before it, unless a rule says otherwise. The first that refuses says
 * why, naming what it would change.
 */
export function changeChecks({ catalog, defaultAdapter }: ChangeCheckDeps): ChangeChecks {
  /** The adapter and the connection a node row runs: its adapter's first, if it names none. */
  const runs = (row: NodeRow): [AdapterId, string | undefined] => {
    const adapter = row.adapter ?? defaultAdapter;
    return [adapter, row.connection ?? adapterIn(catalog, adapter)?.connections[0]?.id];
  };
  return {
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
