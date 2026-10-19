import type { PartyId } from '../../../shared/model/messages';
import type { KeptReads, MovedRead } from '../../run-journal';

/*
 * Where each party has read to in a canvas's messages: its `wait` read position (API Spec §7.7,
 * Core Server §5.9), the place in the store's order of the last message a `wait` without `for`
 * returned it. It is the party's, never its token's, so a token renewed by name reads on from it;
 * it only moves forward, and only once the canvas's record holding it (runs/<id>/record.json,
 * `reads`, forced to disk at every write once it holds any) is on disk, before the `wait` that
 * moved it returns: a restart never returns what one already did, and a `wait` whose record
 * couldn't be written moves nothing.
 */

export class ReadPositions {
  readonly #positions: Map<string, number>;
  readonly #journal: (moved: MovedRead) => Promise<void>;

  /**
   * `kept`: the positions the canvas's record had; `journal`: writes the record with a party's
   * position moved, forced to disk.
   */
  constructor(kept: KeptReads, journal: (moved: MovedRead) => Promise<void>) {
    this.#positions = new Map(Object.entries(kept));
    this.#journal = journal;
  }

  /** Where `party` has read to: 0, before every message, if it never waited. */
  of(party: PartyId): number {
    return this.#positions.get(party) ?? 0;
  }

  /**
   * Moves `party`'s position forward to `seq` (never back), once the record holding it is
   * journaled: resolves then, if it moved. Rejects, moving nothing, if it couldn't be.
   */
  async advance(party: PartyId, seq: number): Promise<void> {
    if (seq <= this.of(party)) return;
    await this.#journal({ party, seq });
    if (seq > this.of(party)) this.#positions.set(party, seq);
  }
}
