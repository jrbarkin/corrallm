import { STORE_BYTES, STORE_SETTLED_PER_PARTY } from '../../../shared/api/limits';
import { isSettled } from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';

/** The old full-scan pruning algorithm, deliberately independent of the indexes being tested. */
export interface PruneRecord {
  seq: number;
  message: Message;
  told?: string;
  withdrawal?: { text: string; told?: boolean };
}

export function scanPrune(kept: Map<string, PruneRecord>): { quota: number; bytes: number } {
  const entries = [...kept.values()];
  const counts = new Map<PartyId, number>();
  const dropped = new Set<string>();
  const settled = ({ message, withdrawal }: PruneRecord) =>
    isSettled(message) && (withdrawal === undefined || withdrawal.told === true);
  for (const one of entries.toReversed()) {
    if (!settled(one)) continue;
    const { message } = one;
    const parties = [message.from, message.to];
    const wanted = parties.some((party) => (counts.get(party) ?? 0) < STORE_SETTLED_PER_PARTY);
    for (const party of parties) counts.set(party, (counts.get(party) ?? 0) + 1);
    if (!wanted) dropped.add(message.id);
  }
  const quota = dropped.size;
  let bytes = entries.reduce(
    (sum, one) => (dropped.has(one.message.id) ? sum : sum + size(one)),
    0,
  );
  for (const one of entries) {
    if (bytes <= STORE_BYTES) break;
    if (dropped.has(one.message.id) || !settled(one)) continue;
    dropped.add(one.message.id);
    bytes -= size(one);
  }
  for (const id of dropped) kept.delete(id);
  return { quota, bytes: dropped.size - quota };
}

function size({ seq, message, told, withdrawal }: PruneRecord): number {
  return Buffer.byteLength(JSON.stringify({ seq, message, told, withdrawal }));
}
