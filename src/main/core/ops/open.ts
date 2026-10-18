import { MAX_PAGE_BYTES } from '../../../shared/api/limits';
import { SURFACE } from '../../../shared/api/surface';
import type { OpName, Reach } from '../../../shared/api/surface';
import type { CanvasId } from '../../../shared/canvas';
import type { AgentNode } from '../../../shared/model/canvas';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import type { Engines, OpenCanvas } from '../engines';

/*
 * What the conversation, session and run operations share: the open canvas a call names, an agent
 * of it, how far the caller reaches for the op (core.call has refused what it doesn't), and how a
 * list is paged.
 */

/**
 * The open canvas `canvas` names: unavailable if it isn't open, or if none is named (core.call
 * names the caller's only one, and asks a caller with several to name one: so it has none).
 */
export function openCanvas(engines: Engines, canvas: string | undefined): OpenCanvas {
  if (canvas === undefined) throw new OpFailure('unavailable', 'No canvas is open in corrallm.');
  const open = engines.canvas(canvas as CanvasId);
  if (!open) throw new OpFailure('unavailable', 'That canvas isn’t open in corrallm.');
  return open;
}

/** Agent `id` of an open canvas: not-found if there is none. */
export function agentOf(open: OpenCanvas, id: string): AgentNode {
  const node = open.document.nodes.find((one) => one.id === id);
  if (node?.type !== 'agent') throw new OpFailure('not-found', `There is no agent ${id}.`);
  return node;
}

/** How far the caller reaches for op `name`: you, everywhere. */
export function reachFor(name: OpName, { party }: OpContext): Reach | 'all' {
  const access = SURFACE[name].access as Readonly<Partial<Record<string, Reach>>>;
  return access[party] ?? 'own';
}

/**
 * A page of `items`: the longest run of them, from the first, whose JSON fits MAX_PAGE_BYTES; at
 * least the first, which `fit` cuts to fit when it alone doesn't (given the bytes it may take), or,
 * with no `fit`, as it is.
 */
export function pageOf<T>(
  items: readonly T[],
  fit: (item: T, room: number) => T = (item) => item,
): T[] {
  const page: T[] = [];
  // The brackets around them, and a comma between each.
  let room = MAX_PAGE_BYTES - 2;
  for (const item of items) {
    const size = bytesOf(item) + (page.length === 0 ? 0 : 1);
    if (size > room) {
      if (page.length === 0) page.push(fit(item, room));
      break;
    }
    page.push(item);
    room -= size;
  }
  return page;
}

/** How many bytes a value takes as JSON. */
export function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
