import type { CanvasId } from '../../../shared/canvas';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { Documents, Revision } from './documents';

/**
 * For tests: commits `next` as the canvas's document, loading it first (a draft's empty one, if it
 * is one), as an op's commit does but checking nothing and in no op's scope. Its revision, or none
 * if it changed nothing.
 */
export async function commitDocument(
  documents: Pick<Documents, 'load' | 'change'>,
  canvas: CanvasId,
  next: CanvasDocument,
  revision: Revision = { op: 'canvas.rename', by: 'you' },
): Promise<number | undefined> {
  await documents.load(canvas);
  const { committed } = await documents.change(canvas, {
    revision,
    build: () => ({ next, result: undefined }),
    check: () => undefined,
    committing: () => undefined,
  });
  return committed?.rev;
}
