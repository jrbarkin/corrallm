/*
 * How big a canvas's boxes are: an agent's card, and the groups that fit what they hold. The views
 * draw them so (src/renderer/graph/GraphEditor.css), and a canvas's file names a group's colour
 * by its index among GROUP_COLORS.
 */

/** An item's card: 150px wide, a 32px label inside a 1px border. Matches `.graph-card`. */
export const CARD_SIZE = { width: 150, height: 34 } as const;
/** Height of a container's header zone (a frame's label bar). Matches `.graph-label` in GraphEditor.css. */
export const HEADER = 32;
/** Space between a container's edges (below its label bar or card) and its children. */
export const PADDING = 20;
/** A frame without children: room for one item. */
export const EMPTY_FRAME = {
  width: CARD_SIZE.width + 2 * PADDING,
  height: HEADER + 2 * PADDING,
} as const;
/** How many colours groups take turns with (`.group-color-0` … in GraphEditor.css). */
export const GROUP_COLORS = 8;
