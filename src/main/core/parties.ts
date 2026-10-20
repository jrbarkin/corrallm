import type { PauseCause } from '../../shared/engine/run/runner';
import type { NodeLike } from '../../shared/model/canvas';
import { agentOf, outsideOf } from '../../shared/model/messages';
import type { PartyId } from '../../shared/model/messages';
import { agentName } from '../../shared/model/queries';
import { threadTitle } from '../../shared/model/session';
import { andList } from '../../shared/model/words';

/*
 * Parties, and the pauses they set, in words, as the core's refusals and notices say them: an
 * agent by its name (on one line, cut short), an outside orchestrator by its name in quotes, the
 * user and corrallm by those names.
 */

/**
 * The most characters of a name a sentence quotes, before escaping, cut at a word: a capped
 * title, never a whole label (API Spec §5.8).
 */
const TITLE = 120;

/**
 * A name in trusted prose: cap first, then quote and escape, never cutting an escape sequence.
 * JSON quotes C0 controls; DEL, C1 controls and Unicode line separators need escaping too.
 */
export function quotedName(name: string): string {
  let capped = name;
  if (name.length > TITLE) {
    const cut = name.slice(0, TITLE);
    const space = cut.lastIndexOf(' ');
    capped = `${(space > TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return JSON.stringify(capped).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A node's name in a sentence without surrounding quotes: capped and escaped by the same rule. */
export function nameOf(nodes: readonly NodeLike[], id: string): string {
  return quotedName(agentName(nodes, id)).slice(1, -1);
}

function rawPartyName(nodes: readonly NodeLike[], party: PartyId): string {
  const agent = agentOf(party);
  return agent === undefined ? (outsideOf(party) ?? party) : agentName(nodes, agent);
}

/** A party's display name, unquoted: separate from names embedded in trusted prose. */
export function partyName(nodes: readonly NodeLike[], party: PartyId): string {
  return threadTitle(rawPartyName(nodes, party), TITLE);
}

/** A party, as a refusal or notice names it: the user, or an outside orchestrator in quotes. */
export function partyText(nodes: readonly NodeLike[], party: PartyId): string {
  if (party === 'you') return 'the user';
  const name = quotedName(rawPartyName(nodes, party));
  return outsideOf(party) === undefined ? name.slice(1, -1) : name;
}

/**
 * A party, as what corrallm tells an agent names it: the user, or anyone else by its name in
 * quotes, so that no name reads as the user's own words.
 */
export function quotedParty(nodes: readonly NodeLike[], party: PartyId): string {
  return party === 'you' ? 'the user' : quotedName(rawPartyName(nodes, party));
}

/**
 * Who set the pauses that hold an agent or a group (`id`), in words: each party, and the group a
 * pause is on when it isn't on `id` itself ('"ops" and by the user on its group "Team"').
 */
export function pausesText(
  nodes: readonly NodeLike[],
  id: string,
  causes: readonly PauseCause[],
): string {
  return andList(
    causes.map(
      ({ id: on, by }, i) =>
        `${i === 0 ? '' : 'by '}${partyText(nodes, by)}${on === id ? '' : ` on its group ${quotedName(agentName(nodes, on))}`}`,
    ),
  );
}

/** What anyone held by a pause is told can release it. */
export const RELEASES = 'only the party that set a pause, or the user, can release it.';
