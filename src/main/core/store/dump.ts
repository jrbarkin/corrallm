import { schemaOf } from './migrations';
import { unfit } from './open';
import { connect } from './sqlite';
import type { Connection } from './sqlite';

/**
 * Inspection only: no core, lock, migrations, repairs, checkpoints or profile creation. One
 * read transaction gives every line the same view, including committed WAL records while an
 * owner writes. A slow reader pins that WAL view; output is awaited rather than buffered whole.
 */
export async function dump(file: string, print: (line: string) => Promise<void>): Promise<void> {
  const reader = connect(file, { readOnly: true, timeout: 0 });
  try {
    reader.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN');
    const wrong = unfit(reader, file);
    if (wrong !== undefined) throw wrong;
    const schema = schemaOf(reader);
    if (schema < 1) throw new Error('The core’s database has not been initialized.');

    for (const canvas of reader
      .prepare(
        `SELECT c.*, o.opened_at FROM canvas c
      LEFT JOIN open_canvas o ON o.canvas_id = c.id ORDER BY c.used_at DESC, c.id`,
      )
      .iterate()) {
      const id = String(canvas.id);
      const document =
        schema < 2
          ? undefined
          : reader.prepare('SELECT * FROM document WHERE canvas_id = ?').get(id);
      await print(
        JSON.stringify({
          type: 'canvas',
          data: canvas,
          conversations: reader
            .prepare('SELECT * FROM conversation WHERE canvas_id = ? ORDER BY adapter, agent_id')
            .all(id),
          document:
            document === undefined
              ? null
              : {
                  ...document,
                  nodes: rows(
                    reader,
                    'SELECT * FROM node WHERE canvas_id = ? ORDER BY place, id',
                    id,
                    ['settings'],
                  ),
                  links: rows(
                    reader,
                    'SELECT * FROM link WHERE canvas_id = ? ORDER BY place, a, b',
                    id,
                    ['dots'],
                  ),
                  items: rows(
                    reader,
                    'SELECT * FROM queue_item WHERE canvas_id = ? ORDER BY agent_id, place, id',
                    id,
                    ['body'],
                  ),
                },
          ...(schema < 2
            ? {
                workflow:
                  reader.prepare('SELECT * FROM run_workflow WHERE canvas_id = ?').get(id) ?? null,
              }
            : {}),
        }),
      );
    }
    for (const run of reader.prepare('SELECT * FROM run ORDER BY canvas_id').iterate()) {
      await print(JSON.stringify({ type: 'run', data: jsonColumns(run, ['state']) }));
    }
    for (const message of reader.prepare('SELECT * FROM message ORDER BY seq').iterate()) {
      await print(
        JSON.stringify({
          type: 'message',
          data: jsonColumns(message, ['task', 'turn', 'delivery', 'withdrawal']),
        }),
      );
    }
  } finally {
    // Closing rolls back the read transaction, never checkpoints the owner's WAL.
    reader.close();
  }
}

type Row = ReturnType<ReturnType<Connection['prepare']>['all']>[number];

function rows(
  reader: Connection,
  sql: string,
  canvas: string,
  json: readonly string[] = [],
): Record<string, unknown>[] {
  return reader
    .prepare(sql)
    .all(canvas)
    .map((row) => jsonColumns(row, json));
}

/** Known JSON columns are objects in the dump, rather than a second layer of quoted JSON. */
function jsonColumns(row: Row, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      columns.includes(key) && typeof value === 'string' ? (JSON.parse(value) as unknown) : value,
    ]),
  );
}
