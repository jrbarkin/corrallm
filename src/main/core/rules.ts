import type { ArgsOf } from '../../shared/api/registry';
import type { RULES } from '../../shared/api/rules';
import type { OpName, Party, SURFACE } from '../../shared/api/surface';
import type { CanvasId } from '../../shared/canvas';
import { andList } from '../../shared/model/words';
import type { RuleOutcome } from './call';
import { partyIdOf } from './caller';
import type { TokenCaller } from './caller';
import type { Engines } from './engines';
import { nameOf, pausesText, RELEASES } from './parties';

/*
 * How the core checks each rule an operation carries on a token's arguments (Core Server §3.6),
 * in the op's scope before it runs: one check per RULES row checked on arguments, for each op that
 * carries it. A rule met refuses the token, saying why; you are never checked.
 */

/** The rules RULES checks on arguments. */
type ArgumentRule = {
  [R in keyof typeof RULES]: (typeof RULES)[R]['kind'] extends 'change' ? never : R;
}[keyof typeof RULES];

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
