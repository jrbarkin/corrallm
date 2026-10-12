import type { Lanes, LinkEnd } from './lanes';

/** A stretch of the rows, in pixels down from the top of the first. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * A link between two lanes (by index), as a diff viewer joins the blocks that differ: from a task
 * in one (what a wait waits for, or a step handed on) to a task in the other (the wait), or to a
 * point (where a step handed on reaches the other agent).
 */
export interface Ribbon {
  key: string;
  kind: 'wait' | 'handoff';
  /** A wait in a loop of waits, which would never run. */
  stuck: boolean;
  from: { lane: number; span: Span };
  to: { lane: number; span: Span };
}

/** The ribbons of the links between lanes, between the spans their ends take (`spanOf`). */
export function ribbonsOf(
  { lanes, links, isStuck }: Lanes,
  spanOf: (end: LinkEnd) => Span | undefined,
): Ribbon[] {
  const index = new Map(lanes.map((lane, i) => [lane.agent.id, i]));
  return links.flatMap((link): Ribbon[] => {
    const from = index.get(link.from.lane);
    const to = index.get(link.kind === 'wait' ? link.to.lane : link.to);
    const span = spanOf(link.from);
    if (from === undefined || to === undefined || from === to || !span) return [];
    if (link.kind === 'handoff') {
      const middle = (span.top + span.bottom) / 2;
      return [
        {
          key: link.key,
          kind: 'handoff',
          stuck: false,
          from: { lane: from, span },
          to: { lane: to, span: { top: middle, bottom: middle } },
        },
      ];
    }
    const wait = spanOf(link.to);
    if (!wait) return [];
    return [
      {
        key: link.key,
        kind: 'wait',
        stuck: isStuck(link.to.lane, link.to.item),
        from: { lane: from, span },
        to: { lane: to, span: wait },
      },
    ];
  });
}

/** Part of a ribbon, in the gap between two lanes: the span it has at the gap's left and right. */
export interface Piece {
  key: string;
  kind: Ribbon['kind'];
  stuck: boolean;
  left: Span;
  right: Span;
  /** Work handed on points into the lane it reaches, on this side of the gap. */
  arrow?: 'left' | 'right';
}

/**
 * The parts of ribbons in the gap after lane `gap` (between it and the next). Between lanes side
 * by side, a ribbon runs from its span in one to its span in the other. One that passes lanes on
 * the way narrows to a line beside the lane it leaves, passes them level, and widens again beside
 * the lane it reaches.
 */
export function piecesIn(ribbons: readonly Ribbon[], gap: number): Piece[] {
  return ribbons.flatMap(({ key, kind, stuck, from, to }): Piece[] => {
    const rightwards = from.lane < to.lane;
    if (gap < Math.min(from.lane, to.lane) || gap >= Math.max(from.lane, to.lane)) return [];
    const middle = (from.span.top + from.span.bottom) / 2;
    const line = { top: middle, bottom: middle };
    const leaving = gap === (rightwards ? from.lane : from.lane - 1) ? from.span : line;
    const reaches = gap === (rightwards ? to.lane - 1 : to.lane);
    const reaching = reaches ? to.span : line;
    const piece: Piece = rightwards
      ? { key, kind, stuck, left: leaving, right: reaching }
      : { key, kind, stuck, left: reaching, right: leaving };
    if (reaches && kind === 'handoff') piece.arrow = rightwards ? 'right' : 'left';
    return [piece];
  });
}

/**
 * A piece's outline in a gap `width` wide (`fill`), its top and bottom edges (`edges`), and its
 * arrowhead if it has one (`arrow`, empty if not).
 */
export function piecePaths(
  { left, right, arrow }: Piece,
  width: number,
): { fill: string; edges: string; arrow: string } {
  const n = String;
  const half = n(width / 2);
  const top = `M 0 ${n(left.top)} C ${half} ${n(left.top)} ${half} ${n(right.top)} ${n(width)} ${n(right.top)}`;
  const bottom = `C ${half} ${n(right.bottom)} ${half} ${n(left.bottom)} 0 ${n(left.bottom)}`;
  const tip =
    arrow === 'right' ? { x: width, y: right.top, back: -7 } : { x: 0, y: left.top, back: 7 };
  return {
    fill: `${top} L ${n(width)} ${n(right.bottom)} ${bottom} Z`,
    edges: `${top} M ${n(width)} ${n(right.bottom)} ${bottom}`,
    arrow:
      arrow === undefined
        ? ''
        : `M ${n(tip.x)} ${n(tip.y)} L ${n(tip.x + tip.back)} ${n(tip.y - 4)} L ${n(tip.x + tip.back)} ${n(tip.y + 4)} Z`,
  };
}
