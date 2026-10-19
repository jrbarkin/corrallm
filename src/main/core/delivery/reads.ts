import type { PartyId } from '../../../shared/model/messages';
import type { KeptReads } from '../../run-journal';

/*
 * Where each party has read to in a canvas's messages: its `wait` read position (API Spec §7.7,
 * Core Server §5.9), the place in the store's order of the last message a `wait` without `for`
 * returned it. It is the party's, never its token's, so a token renewed by name reads on from it;
 * it only moves forward, and only once it is on disk (the journal's `read_position`, committed in
 * one write with every other position the `wait` moves: Engines.advance), before the `wait` that
 * moved it returns: a restart never returns what one already did, and a `wait` whose positions
 * couldn't be written moves none.
 */

export class ReadPositions {
  readonly #positions: Map<string, number>;

  /** `kept`: the positions the journal has for the canvas. */
  constructor(kept: KeptReads) {
    this.#positions = new Map(Object.entries(kept));
  }

  /** Where `party` has read to: 0, before every message, if it never waited. */
  of(party: PartyId): number {
    return this.#positions.get(party) ?? 0;
  }

  /** `party`'s position moved forward to `seq` (never back), now that it is on disk. */
  moved(party: PartyId, seq: number): void {
    if (seq > this.of(party)) this.#positions.set(party, seq);
  }
}
