import type { PauseCause } from '../../shared/engine/run/runner';
import type { NodeLike } from '../../shared/model/canvas';
import { agentOf, outsideOf } from '../../shared/model/messages';
import type { PartyId } from '../../shared/model/messages';
import { agentName } from '../../shared/model/queries';
import { threadTitle } from '../../shared/model/session';
import { andList } from '../../shared/model/words';

/*
 * Parties, and the pauses they set, in words, as the core's refusals and notices say them: an
 * agent by its name (on one line, cut short), an outside orchestrator by its name in quotes, you
 * and corrallm as themselves.
 */

/**
 * The most characters of a node's name a sentence quotes, on one line and cut at a word: a capped
 * title, never a whole label (API Spec §5.8).
 */
const TITLE = 120;

/** A node's name, as a sentence quotes it: on one line, capped. */
export function nameOf(nodes: readonly NodeLike[], id: string): string {
  return threadTitle(agentName(nodes, id), TITLE);
}

/** A party's name, unquoted: an agent's, an outside orchestrator's, or "you" or "corrallm". */
export function partyName(nodes: readonly NodeLike[], party: PartyId): string {
  const agent = agentOf(party);
  return agent === undefined ? (outsideOf(party) ?? party) : nameOf(nodes, agent);
}

/** A party, as a sentence names it: an outside orchestrator's name in quotes, as a frame has it. */
export function partyText(nodes: readonly NodeLike[], party: PartyId): string {
  return outsideOf(party) === undefined ? partyName(nodes, party) : `"${partyName(nodes, party)}"`;
}

/**
 * Who set the pauses that hold an agent or a group (`id`), in words: each party, and the group a
 * pause is on when it isn't on `id` itself ('"ops" and by you on its group "Team"').
 */
export function pausesText(
  nodes: readonly NodeLike[],
  id: string,
  causes: readonly PauseCause[],
): string {
  return andList(
    causes.map(
      ({ id: on, by }, i) =>
        `${i === 0 ? '' : 'by '}${partyText(nodes, by)}${on === id ? '' : ` on its group "${nameOf(nodes, on)}"`}`,
    ),
  );
}

/** What anyone held by a pause is told can release it. */
export const RELEASES = 'only the party that set a pause, or you, can release it.';
