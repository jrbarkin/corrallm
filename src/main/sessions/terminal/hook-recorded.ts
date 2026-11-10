import { readFileSync } from 'node:fs';

/*
 * For tests: how a Terminal CLI's hooks behaved when something held them, recorded from the real
 * CLI in a throwaway home against a local stub model, with a stub hook server that held, answered
 * or ignored each hook (B23). Each adapter keeps its recording beside its other
 * fixtures (`hook-holds.jsonl`); this reads one. A recording is a list of cases; a case is the
 * records between its `case` record and the next:
 *
 * - settings / argv: how the CLI was configured and started (HTTP hooks in its settings for one,
 *   command hooks in its `-c` overrides for the other; the token is a stand-in).
 * - hook-req: a hook request as the stub server received it (its header names and values in the
 *   order sent, and the JSON body), and hook-res what the server answered it, hook-hold that it
 *   left it unanswered, hook-conn-closed that the connection ended (`answered` is whether the
 *   server had replied first: false is the CLI cutting it short).
 * - in: keys sent to the terminal, screen: its visible rows then (blank and decoration rows left
 *   out), note: the recorder's own remark, model-req: what the stub model was asked (the tool
 *   results the CLI sent back are what a decision or an answer became).
 *
 * Times are ms after the case began; paths, ports, ids and tokens are stand-ins.
 */

export type HeaderPairs = readonly (readonly [string, string])[];

export interface RecordedHookRequest {
  id: string;
  method: string;
  url: string;
  httpVersion: string;
  headers: HeaderPairs;
  bodyLength: number;
  body: Record<string, unknown>;
}

export type HoldRecord = { t: number } & (
  | { kind: 'case'; data: { name: string } }
  | { kind: 'settings'; data: unknown }
  | { kind: 'argv'; data: { cmd: string; args: string[] } }
  | { kind: 'hook-req'; data: RecordedHookRequest }
  | { kind: 'hook-res'; data: { id: string; status: number; body: string } }
  | { kind: 'hook-hold'; data: { id: string } }
  | { kind: 'hook-conn-closed'; data: { id: string; answered: boolean } }
  | { kind: 'in'; data: string }
  | { kind: 'screen'; data: { label: string; rows: string[] } }
  | { kind: 'note'; data: string }
  | { kind: 'model-req'; data: { main?: boolean; lastType?: string; toolResults?: unknown[] } }
);

/** A recording's cases, by name, in the order recorded. */
export function recordedHoldCases(file: string): Map<string, HoldRecord[]> {
  const cases = new Map<string, HoldRecord[]>();
  let current: HoldRecord[] | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    const record = JSON.parse(line) as HoldRecord;
    if (record.kind === 'case') {
      current = [];
      cases.set(record.data.name, current);
    } else current?.push(record);
  }
  return cases;
}

/** A case's records of one kind. */
export function holdRecords<K extends HoldRecord['kind']>(
  records: readonly HoldRecord[],
  kind: K,
): Extract<HoldRecord, { kind: K }>[] {
  return records.filter(
    (record): record is Extract<HoldRecord, { kind: K }> => record.kind === kind,
  );
}

/** A case's hook requests for one event. */
export function hookRequests(
  records: readonly HoldRecord[],
  event: string,
  tool?: string,
): Extract<HoldRecord, { kind: 'hook-req' }>[] {
  return holdRecords(records, 'hook-req').filter(
    ({ data }) =>
      data.body.hook_event_name === event && (tool === undefined || data.body.tool_name === tool),
  );
}

/** The value of a header of a recorded request (names compared without case). */
export function headerOf(request: RecordedHookRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** The text on a case's screens, whole: what any of its screens showed. */
export function screens(
  records: readonly HoldRecord[],
): { label: string; text: string; t: number }[] {
  return holdRecords(records, 'screen').map(({ t, data }) => ({
    t,
    label: data.label,
    text: data.rows.join('\n'),
  }));
}

/** The first of a case's records, which the case must have. */
export function first<T>(records: readonly T[], what = 'record'): T {
  const [found] = records;
  if (found === undefined) throw new Error(`the recording has no ${what}`);
  return found;
}
