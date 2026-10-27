import { describe, expect, it } from 'vitest';

import { canvasIdOf, isCanvasId, newCanvasId } from './canvas';

const ID = '7d0c2b9e-4f1a-4c3d-9e8b-2a1f0e6d5c4b';
const file = (fields: Record<string, unknown>) =>
  JSON.stringify({ format: 'corrallm', version: 2, id: ID, nodes: [], ...fields });

describe('canvas identity', () => {
  it.each([2, 3])('reads a version %i canvas’s id', (version) => {
    expect(canvasIdOf(file({ version }))).toBe(ID);
  });

  it('refuses a version 1 canvas, a newer one, and one without a UUID id', () => {
    expect(() => canvasIdOf(file({ version: 1 }))).toThrow(
      'This canvas is from an older version of corrallm, which this one can’t open',
    );
    expect(() => canvasIdOf(file({ version: 4 }))).toThrow(
      'This canvas was made by a newer version of corrallm',
    );
    expect(() => canvasIdOf(file({ version: '2' }))).toThrow('version must be a whole number');
    for (const id of [undefined, 'team', `${ID}\n`, 42]) {
      expect(() => canvasIdOf(file({ id }))).toThrow('id must be the canvas’s id');
    }
  });

  it('refuses what is not a canvas', () => {
    expect(() => canvasIdOf('not json')).toThrow('This is not a corrallm canvas');
    expect(() => canvasIdOf('[]')).toThrow('This is not a corrallm canvas');
    expect(() => canvasIdOf(file({ format: 'other' }))).toThrow('This is not a corrallm canvas');
  });

  it('makes new ids that are UUIDs, each its own', () => {
    const [a, b] = [newCanvasId(), newCanvasId()];
    expect(isCanvasId(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});
