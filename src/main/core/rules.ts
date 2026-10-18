import type { RULES } from '../../shared/api/rules';
import type { CanvasId } from '../../shared/canvas';
import type { PauseTarget } from '../../shared/engine/run/runner';
import { andList } from '../../shared/model/words';
import type { RuleCheck } from './call';
import { partyIdOf } from './caller';
import type { Engines } from './engines';
import { nameOf, pausesText, RELEASES } from './parties';

/*
 * How the core checks each rule an operation carries on a token's arguments (Core Server §3.6),
 * before the op runs: one check per RULES row. A rule met refuses the token, saying why; you are
 * never checked.
 */

export function ruleChecks(engines: Engines): { [R in keyof typeof RULES]: RuleCheck } {
  return {
    // R1: only what you typed may run a shell command, and a body that starts with its recipient's
    // shell prefix would (src/shared/adapter.ts ConnectionDescriptor.shellPrefix).
    'shell-text': ({ canvas, to, body }: { canvas?: CanvasId; to: string; body: string }) => {
      const open = canvas === undefined ? undefined : engines.canvas(canvas);
      const node = open?.document.nodes.find((one) => one.id === to);
      if (!open || node?.type !== 'agent') return undefined;
      const { catalog } = open.engine;
      const connection = catalog.connectionOf(node.data);
      const prefix = catalog.shellPrefix(connection);
      if (prefix === undefined || prefix === '' || !body.trimStart().startsWith(prefix)) {
        return undefined;
      }
      return {
        refuse: `It starts with "${prefix}", which ${catalog.connectionName(connection) ?? 'its connection'} runs as a shell command without asking: only you may send that.`,
      };
    },
    // R9: a token releases only the pauses its own party set; yours (and others') stay. One whose
    // own release would let go of nothing that holds the target is refused, saying who holds it:
    // its own pause on a group the target is in, released on that group, first.
    sticky: ({ canvas, target }: { canvas?: CanvasId; target: PauseTarget }, { caller }) => {
      const open = canvas === undefined ? undefined : engines.canvas(canvas);
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
  };
}
