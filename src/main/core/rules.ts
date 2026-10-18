import type { RULES } from '../../shared/api/rules';
import type { CanvasId } from '../../shared/canvas';
import type { PauseTarget } from '../../shared/engine/run/runner';
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
    // own release would let go of nothing that holds the target is refused, saying who holds it.
    sticky: ({ canvas, target }: { canvas?: CanvasId; target: PauseTarget }, { caller }) => {
      const open = canvas === undefined ? undefined : engines.canvas(canvas);
      if (!open) return undefined;
      const { run } = open.engine;
      const holding = run.holding(target);
      if (holding.length === 0 || run.pausedBy(target).includes(partyIdOf(caller))) {
        return undefined;
      }
      const { nodes } = open.document;
      const id = 'agent' in target ? target.agent : target.group;
      return {
        refuse: `${nameOf(nodes, id)} stays paused by ${pausesText(nodes, id, holding)}: ${RELEASES}`,
      };
    },
  };
}
