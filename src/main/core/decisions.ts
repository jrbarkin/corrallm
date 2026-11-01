import { randomUUID } from 'node:crypto';

import type { Message, PartyId } from '../../shared/model/messages';
import type { SettledDecision, SettledOutcome, SubjectType } from '../../shared/model/settled';
import type { MessageStore } from './delivery/messages';

/*
 * Who decided (Core Server §5.1, B11 Design §7): every answer the reply router gives a run's hold,
 * a session's prompt or a workspace's change is recorded as a `settled` record from corrallm to the
 * item's addressee (you), its `by` the party that decided, in the canvas's message store, so it is
 * kept across restarts and says, to a second answer, who settled it first (a conflict naming them).
 *
 * - What it says is what was decided, by kind ("You approved Builder’s OK on the plan"), never an
 *   answer's values: no typed text, no form's values, no question's answers, no feedback. A secret
 *   answer is never written anywhere; neither is anything a token could read of it (records to you
 *   are yours alone).
 * - A native prompt's decision (B13 §9.2 C9) is worded by the core from the prompt's kind, its
 *   subject's type, what was chosen (a choice's hint, a form's action) and the agent's name alone
 *   (`decisionWords`: "You allowed Builder’s command once"), never a title, a label, a command, a
 *   path, a plan, feedback or an answer, whatever the CLI asked; and, for a prompt the core owns,
 *   recorded typed beside its words too (`settled`, ../../shared/model/settled.ts).
 * - A decision the core makes itself (a run's hold) is recorded in the same write as what it
 *   changed (the run, written with the store's messages: `writeWith`), so both are on disk or
 *   neither is.
 * - One whose effect is outside (a native answer, which the CLI must take) is recorded first as
 *   being made (`delivering`), on disk before the CLI is told, then settled as made, or withdrawn if
 *   the CLI refused it (its prompt stays open). One a crash cut off is unresolved as the canvas's
 *   messages load again (`recoverDecisions`): its answer may or may not have reached the CLI, so it
 *   is never sent again, and the record says so.
 *
 * Each is kept under the told key `decided:<need>#<uuid>`, so the latest for a Needs item is found
 * by its id alone (`decidedOf`).
 */

const PREFIX = 'decided:';

/** The told key prefix of every decision of a Needs item. */
function keyOf(need: string): string {
  return `${PREFIX}${need}#`;
}

/** A decision as it is recorded: of which item, by whom, and what, in words without values. */
export interface Decision {
  need: string;
  by: PartyId;
  /** What was decided, a sentence: never an answer's values. */
  words: string;
  /** To whom it is addressed: you, unless said. */
  to?: PartyId;
  /** A native prompt's decision, typed and value-free, kept with its record. */
  settled?: SettledDecision;
}

/** Records a decision made now (its effect in the same write as the record). */
export function decided(messages: MessageStore, decision: Decision): Message {
  return messages.add(draftOf(decision, 'delivered'), `${keyOf(decision.need)}${randomUUID()}`);
}

/**
 * Records a decision whose effect is outside (a native answer), as being made: settle it with
 * `landed` once the CLI took it, or `withdrawnDecision` if it didn't.
 */
export function deciding(messages: MessageStore, decision: Decision): Message {
  return messages.add(draftOf(decision, 'delivering'), `${keyOf(decision.need)}${randomUUID()}`);
}

/** The decision being made took effect. */
export function landed(messages: MessageStore, id: string): void {
  messages.update(id, { state: 'delivered' });
}

/**
 * The decision being made didn't take effect (`why`, a clause: "Reviewer’s CLI didn’t take this
 * answer"): its item still waits for an answer, and its record says so.
 */
export function withdrawnDecision(messages: MessageStore, id: string, why: string): void {
  const record = messages.get(id);
  messages.update(id, {
    state: 'withdrawn',
    by: 'corrallm',
    ...(record === undefined ? {} : { body: `${why}, so it changed nothing: ${record.body}` }),
  });
}

/**
 * The latest decision of a Needs item that took effect, or may have (one cut off), if one is kept:
 * what a second answer is told settled it.
 */
export function decidedOf(messages: MessageStore, need: string): Message | undefined {
  return messages
    .toldStarting(keyOf(need))
    .filter(({ state }) => state !== 'withdrawn')
    .at(-1);
}

/**
 * As a canvas's messages load: each decision a crash cut off while it was being made is
 * unresolved, never made again. Whether any was.
 */
export function recoverDecisions(messages: MessageStore): boolean {
  let any = false;
  for (const message of messages.toldStarting(PREFIX)) {
    if (message.state !== 'delivering') continue;
    messages.update(message.id, {
      state: 'unresolved',
      body: `${message.body.replace(/[.\s]+$/, '')}: corrallm stopped as it was answering, so it may not have reached the agent’s CLI. It isn’t sent again: look at the agent’s session.`,
    });
    any = true;
  }
  return any;
}

/** A decision's record, from corrallm, to its addressee. */
function draftOf(decision: Decision, state: 'delivered' | 'delivering') {
  return {
    from: 'corrallm' as const,
    to: decision.to ?? ('you' as const),
    kind: 'settled' as const,
    origin: 'party' as const,
    body: decision.words,
    state,
    by: decision.by,
    ...(decision.settled === undefined ? {} : { settled: decision.settled }),
  };
}

/** What a decision's words call a prompt's subject, by its type. */
const SUBJECTS: Readonly<Record<SubjectType, string>> = {
  command: 'command',
  fileChange: 'file change',
  mcpTool: 'MCP tool call',
  network: 'network access',
  permissions: 'request for permissions',
  tool: 'tool call',
  trust: 'request to trust its folder',
  consent: 'request for consent',
};

/**
 * What a native prompt's answer decided, as a clause after who decided ("allowed Builder’s
 * command once"), in the core's words from the prompt's kind, its subject's type, what was chosen
 * and the agent's `name` (and whether a form is a link to open): never a title, a label, a
 * command, a path, a plan, feedback, an answer or a value.
 */
export function decisionWords(
  name: string,
  {
    prompt,
    outcome,
    secret,
  }: {
    prompt: { kind: SettledDecision['prompt']['kind']; subject?: SubjectType | undefined };
    outcome: SettledOutcome;
    secret?: true | undefined;
  },
  link = false,
): string {
  switch (outcome.type) {
    case 'choice': {
      const allows = outcome.hint === 'allow_once' || outcome.hint === 'allow_always';
      if (prompt.kind === 'plan') {
        return allows ? `approved ${name}’s plan` : `asked ${name} to keep planning`;
      }
      const what = prompt.subject === undefined ? 'request' : SUBJECTS[prompt.subject];
      const when = outcome.hint.endsWith('_always') ? ' from now on' : allows ? ' once' : '';
      return `${allows ? 'allowed' : 'refused'} ${name}’s ${what}${when}`;
    }
    case 'answers':
      return `answered ${name}’s question${outcome.count === 1 ? '' : 's'}${secret === true ? ' (secret)' : ''}`;
    case 'form': {
      const verb =
        outcome.action === 'accept'
          ? 'accepted'
          : outcome.action === 'decline'
            ? 'declined'
            : 'cancelled';
      return `${verb} ${name}’s ${link ? 'link' : 'form'}`;
    }
  }
}
