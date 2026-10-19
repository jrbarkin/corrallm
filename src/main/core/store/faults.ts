import type { Connection } from './sqlite';

/*
 * SQLite's quick check of a database (about 20 ms per 40 MB): what opening core.db, and taking a
 * snapshot of it, ask before they trust it.
 */

/** What SQLite's quick check finds wrong with a database, in short (its first two faults). */
export function faults(connection: Connection): string | undefined {
  const found = connection
    .prepare('PRAGMA quick_check')
    .all()
    .map((row) => String(row.quick_check));
  if (found.length === 1 && found[0] === 'ok') return undefined;
  const lines = found.flatMap((row) => row.split('\n'));
  // Its heading (*** in database main ***) says nothing of what it found.
  const said = lines.filter((line) => line !== '' && !line.startsWith('***'));
  return said.slice(0, 2).join('; ').slice(0, 300);
}
