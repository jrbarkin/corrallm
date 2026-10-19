import { randomUUID } from 'node:crypto';

import type { Connection } from './sqlite';

/*
 * What a database restored from a snapshot settles as it opens, in the restore's transaction
 * (Core Database §5: restoring is pessimistic, as a restart is). A message that waited for its
 * agent in the snapshot may have been delivered since it was taken, so it is never sent: it becomes
 * unresolved, and its sender is told, by a notice numbered after every place given before. One
 * being delivered, or whose turn went on, is cut off as its canvas opens, as after any restart.
 */

/** Settles the messages that waited in a restored database, as of `now`. */
export function settleRestored(connection: Connection, now: number): void {
  const waited = connection
    .prepare(
      "SELECT id, canvas_id, from_party FROM message WHERE kind = 'text' AND state = 'pending' ORDER BY seq",
    )
    .all();
  const unresolve = connection.prepare(
    "UPDATE message SET state = 'unresolved', turn = ? WHERE id = ?",
  );
  const tell = connection.prepare(
    `INSERT INTO message (id, canvas_id, from_party, to_party, kind, body, reply_to, turn, state,
       sent_at)
     VALUES (?, ?, 'corrallm', ?, 'notice', ?, ?, ?, 'delivered', ?)`,
  );
  for (const { id, canvas_id: canvas, from_party: from } of waited) {
    const body = `Your message ${String(id)} won’t be sent: corrallm’s database was restored from a snapshot taken while it waited, so whether it went since is unknown.`;
    const turn = JSON.stringify({ status: 'failed', reason: 'error', message: body });
    unresolve.run(turn, id ?? null);
    if (from !== 'corrallm') {
      tell.run(randomUUID(), canvas ?? null, from ?? null, body, id ?? null, turn, now);
    }
  }
}
