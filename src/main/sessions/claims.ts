import type { AdapterId } from '../../shared/adapter';
import type { CanvasId } from '../../shared/canvas';
import { isNativeId } from './id';

/*
 * The live claims on native conversations (B11 Design §7, Core Server §7.7): which session of which
 * canvas's agent holds each native conversation, so that no two sessions of this core ever run one
 * conversation at once. A claim is keyed by the adapter and the native id alone, never a folder, so
 * one conversation can't be claimed twice through two directories; whether a directory may resume
 * it is a separate admission (SessionManager's listings). A claim is live process state, never
 * kept: a core starting again holds none. It protects nothing outside this core: another
 * profile's core, or a CLI run outside corrallm, may still open the same conversation, which this
 * is no lock against.
 */

/**
 * Who holds a conversation: one session of a canvas's agent, by the generation the session manager
 * gave it as it started, or a generation reserved for its agent's next session.
 */
export interface ClaimOwner {
  readonly canvas: CanvasId;
  readonly agent: string;
  readonly generation: number;
}

/** Whether a claim was made: if not, who holds the conversation. */
export type Claimed = { ok: true } | { ok: false; holder: ClaimOwner };

interface Claim {
  owner: ClaimOwner;
  /**
   * Reserved for its agent's next session (an explicit resume, a rewind's copy), which no session
   * runs yet: that session takes it over as it starts.
   */
  reserved: boolean;
}

export class ConversationClaims {
  readonly #claims = new Map<string, Claim>();

  /** Who holds the conversation `id` of `adapter`, if anyone does. */
  holder(adapter: AdapterId, id: string): ClaimOwner | undefined {
    return this.#claims.get(keyOf(adapter, id))?.owner;
  }

  /**
   * Claims the conversation `id` of `adapter` for `owner`'s session, at once (nothing awaited
   * between its check and its claim, so two starts never both pass): it is the owner's if nobody
   * holds it, or an earlier generation of the same canvas's agent does (its session replaced or
   * closing, or its reservation); never another agent's, nor a later generation's of its own, which
   * is returned as its holder. Throws for an id that isn't a native conversation's (R42a's platform
   * minimum: its adapter's shape is checked before).
   */
  claim(adapter: AdapterId, id: string, owner: ClaimOwner): Claimed {
    return this.#claim(adapter, id, owner, false);
  }

  /**
   * Reserves the conversation `id` of `adapter` for `owner`'s agent's next session, as `claim`
   * would claim it: held until that session takes it over, or its agent's reservations are let go.
   * That session resumes one conversation of `adapter`, so this one replaces any the agent had
   * reserved of it before (a resume picked again, a rewind after a resume), once it is made.
   */
  reserve(adapter: AdapterId, id: string, owner: ClaimOwner): Claimed {
    return this.#claim(adapter, id, owner, true);
  }

  /**
   * Releases what exactly `owner`'s generation holds (but `keep`, the one it now runs): never a
   * later generation's claim, nor another agent's, so a late close can't release its replacement's.
   */
  release(owner: ClaimOwner, keep?: { adapter: AdapterId; id: string }): void {
    const kept = keep === undefined ? undefined : keyOf(keep.adapter, keep.id);
    for (const [key, claim] of this.#claims) {
      if (
        key !== kept &&
        sameAgent(claim.owner, owner) &&
        claim.owner.generation === owner.generation
      ) {
        this.#claims.delete(key);
      }
    }
  }

  /**
   * Lets go of the reservations of `canvas`'s agents (of `agent` alone, of `adapter`'s
   * conversations alone, if named): the conversations they were for were forgotten, or the canvas's
   * sessions ended. What a session runs stays claimed until that session has closed.
   */
  unreserve(
    canvas: CanvasId,
    { agent, adapter }: { agent?: string; adapter?: AdapterId } = {},
  ): void {
    for (const [key, { owner, reserved }] of this.#claims) {
      if (
        reserved &&
        owner.canvas === canvas &&
        (agent === undefined || owner.agent === agent) &&
        (adapter === undefined || key.startsWith(`${adapter}\u0000`))
      ) {
        this.#claims.delete(key);
      }
    }
  }

  #claim(adapter: AdapterId, id: string, owner: ClaimOwner, reserved: boolean): Claimed {
    if (!isNativeId(id)) throw new TypeError(`Invalid ${adapter} conversation id.`);
    const key = keyOf(adapter, id);
    const held = this.#claims.get(key)?.owner;
    if (held !== undefined && (!sameAgent(held, owner) || held.generation > owner.generation)) {
      return { ok: false, holder: held };
    }
    if (reserved) {
      for (const [other, claim] of this.#claims) {
        if (
          other !== key &&
          claim.reserved &&
          sameAgent(claim.owner, owner) &&
          other.startsWith(`${adapter}\u0000`)
        ) {
          this.#claims.delete(other);
        }
      }
    }
    this.#claims.set(key, { owner, reserved });
    return { ok: true };
  }
}

function keyOf(adapter: AdapterId, id: string): string {
  return `${adapter}\u0000${id}`;
}

function sameAgent(one: ClaimOwner, other: ClaimOwner): boolean {
  return one.canvas === other.canvas && one.agent === other.agent;
}
