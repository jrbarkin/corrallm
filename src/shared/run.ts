import type { CanvasId } from './canvas';

/** Queue/run metadata only. Native CLIs remain the source of conversation history. */
export interface RunCheckpoint {
  version: 2;
  workflow: string;
  state: string;
  messages: string;
  updatedAt: number;
}

/**
 * What a window restores: main owns the canvas's path and gives its id and a generation token,
 * never a writable path.
 */
export interface RunContext {
  id: CanvasId;
  token: string;
  checkpoint: RunCheckpoint | null;
  name: string | null;
  project?: { name: string; path: string };
  savedText?: string;
  warning?: string;
}

export const MAX_RUN_BYTES = 32 * 1024 * 1024;
const MAX_JSON_NODES = 200_000;

/** Main bounds the opaque JSON; the renderer validates its workflow/run schema in depth. */
export function parseRunCheckpoint(
  value: unknown,
  /** The workflow is one already read as it is (a run's, unchanged): its JSON isn't read again. */
  checked: { workflow?: boolean } = {},
): RunCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a run checkpoint');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['version', 'workflow', 'state', 'messages', 'updatedAt'].includes(key),
    ) ||
    record.version !== 2 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    throw new TypeError('Invalid run checkpoint version or timestamp');
  }
  let size = 0;
  for (const key of ['workflow', 'state', 'messages'] as const) {
    const text = record[key];
    if (typeof text !== 'string') throw new TypeError(`Expected run ${key} JSON`);
    size += text.length;
    if (size > MAX_RUN_BYTES) throw new RangeError('The run checkpoint is too large');
    if (key === 'workflow' && checked.workflow === true) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeError(`Invalid run ${key} JSON`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new TypeError(`Expected run ${key} to be a JSON object or array`);
    }
    const remaining = { nodes: MAX_JSON_NODES };
    boundJson(parsed, 0, remaining);
  }
  return record as unknown as RunCheckpoint;
}

function boundJson(value: unknown, depth: number, remaining: { nodes: number }): void {
  if (depth > 64 || --remaining.nodes < 0) throw new RangeError('Run JSON is too complex');
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) boundJson(child, depth + 1, remaining);
  }
}
