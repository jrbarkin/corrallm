/** How the shortcuts read on this platform, for tooltips. */
export const SHORTCUTS = navigator.userAgent.includes('Mac')
  ? { group: '⌘G', groupUnderParent: '⌥⌘G', ungroup: '⇧⌘G' }
  : { group: 'Ctrl+G', groupUnderParent: 'Ctrl+Alt+G', ungroup: 'Ctrl+Shift+G' };

/** Editor commands that have a keyboard shortcut. */
export type KeyAction = 'delete' | 'group' | 'groupUnderParent' | 'ungroup' | 'rename';

/**
 * Maps a document keydown to an editor command, or null. Keys typed into a text field are
 * ignored. G is matched by the letter the keyboard layout types (`key`), so Dvorak and Colemak
 * work. When `key` is not a Latin letter (Option on macOS turns it into '©'; non-Latin layouts),
 * the physical G key (`code`) is used instead, so ⌥⌘G stays position-based on non-QWERTY macOS
 * layouts.
 *
 * - Delete / Backspace: delete the selection
 * - ⌘G / Ctrl+G: group in a frame; ⌥⌘G / Ctrl+Alt+G: group under a new parent node
 * - ⇧⌘G / Ctrl+Shift+G: ungroup
 * - F2: rename the selected node in place
 */
export function keyAction(event: KeyboardEvent): KeyAction | null {
  if (event.isComposing || isEditableTarget(event.target)) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    return mod || event.altKey ? null : 'delete';
  }
  if (event.key === 'F2') return 'rename';
  const isG = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'g' : event.code === 'KeyG';
  if (isG && mod && !event.repeat) {
    if (event.shiftKey) return event.altKey ? null : 'ungroup';
    return event.altKey ? 'groupUnderParent' : 'group';
  }
  return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}
