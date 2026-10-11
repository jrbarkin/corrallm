import { getBezierPath, Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { pointOnBezier } from './curve';

describe('pointOnBezier', () => {
  it.each([
    ['downwards', { sourceX: 0, sourceY: 0, targetX: 200, targetY: 300 }],
    ['back upwards', { sourceX: 200, sourceY: 300, targetX: 0, targetY: 0 }],
  ])('follows the curve React Flow draws %s: its middle is React Flow’s', (_label, ends) => {
    const edge = { ...ends, sourcePosition: Position.Bottom, targetPosition: Position.Top };
    const [, labelX, labelY] = getBezierPath(edge);
    const middle = pointOnBezier(edge, 0.5);
    expect(middle.x).toBeCloseTo(labelX);
    expect(middle.y).toBeCloseTo(labelY);
    expect(pointOnBezier(edge, 0)).toEqual({ x: ends.sourceX, y: ends.sourceY });
    expect(pointOnBezier(edge, 1)).toEqual({ x: ends.targetX, y: ends.targetY });
  });
});
