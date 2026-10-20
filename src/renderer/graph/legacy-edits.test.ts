import { expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { ApiError } from '../api/bridge';
import { CanvasEdits } from './legacy-edits';

it('rebuilds a refused whole-document edit from the mirror before reapplying it', async () => {
  let doc: CanvasDocument = {
    id: newCanvasId(),
    arrange: true,
    nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Original' } }],
    links: [],
  };
  let rev = 1;
  const write = vi.fn((next: CanvasDocument, expected: number) => {
    if (write.mock.calls.length === 1) {
      doc = {
        ...doc,
        nodes: doc.nodes.map((n) => ({ ...n, data: { ...n.data, label: 'Token edit' } })),
      };
      rev = 2;
      return Promise.reject(
        new ApiError({
          code: 'conflict',
          sentence: 'Canvas changed',
          current: { 'node/a': { rev: 2, value: null } },
        }),
      );
    }
    expect(expected).toBe(2);
    doc = next;
    rev = 3;
    return Promise.resolve(rev);
  });
  const edits = new CanvasEdits({
    read: () => ({ document: doc, rev }),
    write,
    refresh: () => Promise.resolve(),
    changed: () => undefined,
  });
  await edits.edit((doc) => ({
    ...doc,
    nodes: doc.nodes.map((n) => ({ ...n, data: { ...n.data, role: 'My role' } })),
  }));
  expect(write).toHaveBeenCalledTimes(2);
  expect(doc.nodes[0]?.data).toEqual({ label: 'Token edit', role: 'My role' });
  expect(doc.arrange).toBe(true);
  expect(edits.document()).toBe(doc);
});

it('shows a repeated conflict instead of retrying forever or keeping the refused copy', async () => {
  const doc: CanvasDocument = { id: newCanvasId(), arrange: false, nodes: [], links: [] };
  const changed = vi.fn();
  const edits = new CanvasEdits({
    read: () => ({ document: doc, rev: 1 }),
    write: () => Promise.reject(new ApiError({ code: 'conflict', sentence: 'Changed again' })),
    refresh: () => Promise.resolve(),
    changed,
  });
  await expect(edits.edit((doc) => ({ ...doc, arrange: true }))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(edits.document()).toBe(doc);
});

it('writes another edit enqueued as the preceding edit resolves', async () => {
  let doc: CanvasDocument = { id: newCanvasId(), arrange: false, nodes: [], links: [] };
  let rev = 1;
  const edits = new CanvasEdits({
    read: () => ({ document: doc, rev }),
    write: (next) => {
      doc = next;
      return Promise.resolve(++rev);
    },
    refresh: () => Promise.resolve(),
    changed: () => undefined,
  });
  await edits.edit((doc) => ({ ...doc, arrange: true }));
  await edits.edit((doc) => ({ ...doc, arrange: false }));
  await edits.flush();
  expect(rev).toBe(3);
  expect(doc.arrange).toBe(false);
});
