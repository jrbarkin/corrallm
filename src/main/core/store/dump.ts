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

    // Schema 3's repositories, which canvases' workspaces refer to, first: each with its setup.
    if (schema >= 3) {
      for (const repository of reader
        .prepare('SELECT * FROM repository ORDER BY real_root, id')
        .iterate()) {
        await print(
          JSON.stringify({
            type: 'repository',
            data: repository,
            setup:
              reader
                .prepare('SELECT * FROM project_setup WHERE repository_id = ?')
                .get(String(repository.id)) ?? null,
          }),
        );
      }
    }

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
          ...(schema < 3 ? {} : workspacesOf(reader, id)),
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

/**
 * A canvas's workspace records (schema 3): its project folder's repository and generation, each
 * workspace with its setup and its jobs, and each agent's binding.
 */
function workspacesOf(reader: Connection, canvas: string): Record<string, unknown> {
  return {
    repository:
      reader.prepare('SELECT * FROM canvas_repository WHERE canvas_id = ?').get(canvas) ?? null,
    worktrees: reader
      .prepare('SELECT * FROM worktree WHERE canvas_id = ? ORDER BY created_at, id')
      .all(canvas)
      .map((worktree) => {
        const id = String(worktree.id);
        return {
          ...worktree,
          setup:
            reader.prepare('SELECT * FROM worktree_setup WHERE workspace_id = ?').get(id) ?? null,
          jobs: rows(
            reader,
            'SELECT * FROM worktree_job WHERE workspace_id = ? ORDER BY created_at, id',
            id,
            ['payload'],
          ),
        };
      }),
    bindings: reader
      .prepare('SELECT * FROM agent_worktree WHERE canvas_id = ? ORDER BY agent_id')
      .all(canvas),
  };
}

/** The rows `sql` selects for `key`, their known JSON columns decoded. */
function rows(
  reader: Connection,
  sql: string,
  key: string,
  json: readonly string[] = [],
): Record<string, unknown>[] {
  return reader
    .prepare(sql)
    .all(key)
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
