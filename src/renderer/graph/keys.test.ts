import { describe, expect, it } from 'vitest';

import { keyAction } from './keys';

/** Dispatches a keydown from `target` (which sets `event.target`) and maps it. */
function press(init: KeyboardEventInit, target: Element = document.body) {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  target.dispatchEvent(event);
  return keyAction(event);
}

describe('keyAction', () => {
  it('deletes on Delete and Backspace without modifiers', () => {
    expect(press({ key: 'Delete' })).toBe('delete');
    expect(press({ key: 'Backspace' })).toBe('delete');
    expect(press({ key: 'Backspace', metaKey: true })).toBeNull();
    expect(press({ key: 'Backspace', altKey: true })).toBeNull();
  });

  it('maps ⌘/Ctrl+G, with Alt or Shift, to the grouping commands', () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(press({ key: 'g', code: 'KeyG', ...mod })).toBe('group');
      expect(press({ key: '©', code: 'KeyG', altKey: true, ...mod })).toBe('groupUnderParent');
      expect(press({ key: 'G', code: 'KeyG', shiftKey: true, ...mod })).toBe('ungroup');
    }
    expect(press({ key: 'g', code: 'KeyG' })).toBeNull();
    expect(press({ key: 'g', code: 'KeyG', metaKey: true, repeat: true })).toBeNull();
    expect(
      press({ key: 'G', code: 'KeyG', metaKey: true, shiftKey: true, altKey: true }),
    ).toBeNull();
  });

  it('matches G by the letter the layout types, and by position only when that is not a letter', () => {
    // Dvorak types g on the QWERTY U key, and i on the G key; Colemak types g on the T key.
    expect(press({ key: 'g', code: 'KeyU', ctrlKey: true })).toBe('group');
    expect(press({ key: 'i', code: 'KeyG', ctrlKey: true })).toBeNull();
    expect(press({ key: 'G', code: 'KeyT', ctrlKey: true, shiftKey: true })).toBe('ungroup');
    // Non-Latin layouts (here Russian) fall back to the physical key.
    expect(press({ key: 'п', code: 'KeyG', ctrlKey: true })).toBe('group');
  });

  it('renames on F2', () => {
    expect(press({ key: 'F2' })).toBe('rename');
  });

  it('ignores keys typed into text fields', () => {
    const input = document.body.appendChild(document.createElement('input'));
    const editable = document.body.appendChild(document.createElement('div'));
    editable.setAttribute('contenteditable', 'true');
    try {
      expect(press({ key: 'Backspace' }, input)).toBeNull();
      expect(press({ key: 'g', code: 'KeyG', metaKey: true }, editable)).toBeNull();
    } finally {
      input.remove();
      editable.remove();
    }
  });

  it('ignores keys while an IME is composing', () => {
    expect(press({ key: 'Backspace', isComposing: true })).toBeNull();
  });
});
