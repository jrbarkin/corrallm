import type { PartyId } from '../../../shared/model/messages';

/*
 * Where each party has read to in a canvas's messages: its `wait` read position (API Spec §7.7,
 * Core Server §5.9), the place in the store's order of the last message a `wait` without `for`
 * returned it. It is the party's, never its token's, so a token renewed by name reads on from it;
 * it only moves forward, and is journaled in the canvas's record (runs/<id>/record.json, `reads`)
 * before the `wait` that moved it returns, so a restart never returns what one already did.
 */

export class ReadPositions {
  readonly #positions: Map<string, number>;
  readonly #journal: () => Promise<void>;

  /** `kept`: the positions the canvas's record had; `journal`: writes the record, positions too. */
  constructor(kept: Readonly<Record<string, number>>, journal: () => Promise<void>) {
    this.#positions = new Map(Object.entries(kept));
    this.#journal = journal;
  }

  /** Where `party` has read to: 0, before every message, if it never waited. */
  of(party: PartyId): number {
    return this.#positions.get(party) ?? 0;
  }

  /** Every party's position, as the canvas's record keeps them. */
  all(): Record<string, number> {
    return Object.fromEntries(this.#positions);
  }

  /**
   * Moves `party`'s position forward to `seq` (never back): resolves once the record holding it is
   * journaled, if it moved. Rejects if it couldn't be.
   */
  async advance(party: PartyId, seq: number): Promise<void> {
    if (seq <= this.of(party)) return;
    this.#positions.set(party, seq);
    await this.#journal();
  }
}
