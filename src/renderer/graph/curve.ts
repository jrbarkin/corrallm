import { Position } from '@xyflow/react';

/** An edge's two ends, as React Flow hands them to an edge view. */
interface Ends {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}

/** React Flow's default bezier curvature (getBezierPath). */
const CURVATURE = 0.25;

/**
 * The point a fraction `t` along an edge drawn with React Flow's getBezierPath: 0 at its source, 1
 * at its target. For placing something on an edge away from its middle. The control points are
 * React Flow's (@xyflow/system's getControlWithCurvature, which it does not export).
 */
export function pointOnBezier(ends: Ends, t: number): { x: number; y: number } {
  const { sourceX, sourceY, targetX, targetY } = ends;
  const [c1x, c1y] = control(ends.sourcePosition, sourceX, sourceY, targetX, targetY);
  const [c2x, c2y] = control(ends.targetPosition, targetX, targetY, sourceX, sourceY);
  const u = 1 - t;
  const along = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { x: along(sourceX, c1x, c2x, targetX), y: along(sourceY, c1y, c2y, targetY) };
}

function offset(distance: number): number {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

/** The control point for the end at (x1, y1), leaving it towards `position`; (x2, y2) is the other end. */
function control(position: Position, x1: number, y1: number, x2: number, y2: number) {
  switch (position) {
    case Position.Left:
      return [x1 - offset(x1 - x2), y1] as const;
    case Position.Right:
      return [x1 + offset(x2 - x1), y1] as const;
    case Position.Top:
      return [x1, y1 - offset(y1 - y2)] as const;
    case Position.Bottom:
      return [x1, y1 + offset(y2 - y1)] as const;
  }
}
