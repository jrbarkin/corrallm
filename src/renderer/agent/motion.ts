/** The easings of growing (fast, then settling) and of shrinking away (slow, then fast). */
const GROW = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
const SHRINK = 'cubic-bezier(0.4, 0, 0.8, 0.4)';

/**
 * Animates a panel between a small box on screen (`small`: the agent's card on the canvas, or the
 * ⊕ or a card in the agent view's rail) and its own box: growing out of it when opening, shrinking
 * into it when closing. With `fade`, it fades in as it grows, or out as it lands.
 */
export function morph(
  element: HTMLElement,
  small: DOMRect,
  direction: 'open' | 'close',
  { duration = direction === 'open' ? 380 : 260, fade = false } = {},
): Animation | undefined {
  const box = element.getBoundingClientRect();
  const atSmall = {
    transform: `translate(${String(small.left - box.left)}px, ${String(small.top - box.top)}px) scale(${String(small.width / box.width)}, ${String(small.height / box.height)})`,
  };
  const atBox = { transform: 'none' };
  return direction === 'open'
    ? animate(
        element,
        fade
          ? [
              { ...atSmall, opacity: 0 },
              { opacity: 1, offset: 0.3 },
              { ...atBox, opacity: 1 },
            ]
          : [atSmall, atBox],
        { duration, easing: GROW },
      )
    : animate(
        element,
        fade
          ? [
              { ...atBox, opacity: 1 },
              { opacity: 1, offset: 0.5 },
              { ...atSmall, opacity: 0 },
            ]
          : [atBox, atSmall],
        { duration, easing: SHRINK, fill: 'forwards' },
      );
}

/**
 * Slides elements from where they were (`before`, measured by `key` before a change) to where they
 * are now: a list making room, or closing a gap. Elements that were not there before stay put.
 */
export function slide(
  elements: Iterable<HTMLElement>,
  key: (element: HTMLElement) => string | undefined,
  before: ReadonlyMap<string, DOMRect>,
  duration: number,
): Animation[] {
  return [...elements].flatMap((element) => {
    const id = key(element);
    const was = id === undefined ? undefined : before.get(id);
    if (!was) return [];
    const now = element.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (dx === 0 && dy === 0) return [];
    return (
      animate(
        element,
        [{ transform: `translate(${String(dx)}px, ${String(dy)}px)` }, { transform: 'none' }],
        { duration, easing: GROW },
      ) ?? []
    );
  });
}

/** `element.animate`, unless the user asked for reduced motion or there is no Web Animations API. */
export function animate(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | undefined {
  if (!('animate' in element)) return undefined;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
  return element.animate(keyframes, options);
}

/** Finishes what is animating `element`, so it can be measured where it rests. */
export function settle(element: HTMLElement): void {
  if ('getAnimations' in element)
    for (const animation of element.getAnimations()) animation.finish();
}
