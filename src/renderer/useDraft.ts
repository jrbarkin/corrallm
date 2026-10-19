import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

const IDLE_MS = 600;
const pending = new Set<() => void>();
let flushing = false;
let fields = 0;

/** Commits the window's pending text before another gesture reads the graph or starts work. */
export function flushDrafts(): void {
  if (flushing || pending.size === 0) return;
  flushing = true;
  try {
    // The graph and its engine must see the commits before the gesture continues.
    flushSync(() => {
      for (const commit of [...pending]) commit();
    });
  } finally {
    flushing = false;
  }
}

/** Pointer actions, drags and keyboard shortcuts flush before their handlers run, portals too. */
function beforeGesture(event: Event): void {
  const target = event.target instanceof Element ? event.target : undefined;
  if (event instanceof globalThis.KeyboardEvent) {
    if (event.isComposing || target?.closest('input, textarea, [contenteditable]')) return;
  } else if (target?.closest('[data-draft]') === document.activeElement) return;
  flushDrafts();
}

/** A field's local text: leave, single-line Enter or a pause commits; Escape drops the draft. */
export function useDraft(
  value: string,
  onCommit: (text: string) => void,
  { multiline = false }: { multiline?: boolean } = {},
) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const latest = useRef({ value, onCommit });
  const state = useRef({
    dirty: false,
    original: value,
    text: value,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useLayoutEffect(() => {
    latest.current = { value, onCommit };
  });
  useLayoutEffect(() => {
    if (state.current.dirty) return;
    state.current.text = state.current.original = value;
    setText(value);
  }, [value]);

  const commit = useCallback(function commit() {
    const draft = state.current;
    clearTimeout(draft.timer);
    pending.delete(commit);
    if (!draft.dirty) return;
    draft.dirty = false;
    const changed = draft.text !== draft.original && draft.text !== latest.current.value;
    draft.original = draft.text;
    if (changed) latest.current.onCommit(draft.text);
  }, []);

  useEffect(() => {
    const draft = state.current;
    if (fields++ === 0) {
      for (const type of ['pointerdown', 'click', 'dragstart', 'drop', 'keydown'])
        document.addEventListener(type, beforeGesture, true);
      window.addEventListener('beforeunload', beforeGesture);
    }
    return () => {
      pending.delete(commit);
      clearTimeout(draft.timer);
      if (--fields === 0) {
        for (const type of ['pointerdown', 'click', 'dragstart', 'drop', 'keydown'])
          document.removeEventListener(type, beforeGesture, true);
        window.removeEventListener('beforeunload', beforeGesture);
      }
    };
  }, [commit]);

  return {
    'data-draft': '',
    value: focused ? text : value,
    onFocus: () => {
      const draft = state.current;
      setFocused(true);
      draft.original = draft.text = latest.current.value;
      setText(draft.text);
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const draft = state.current;
      setFocused(true);
      draft.dirty = true;
      draft.text = event.target.value;
      setText(draft.text);
      clearTimeout(draft.timer);
      pending.add(commit);
      draft.timer = setTimeout(commit, IDLE_MS);
    },
    onBlur: () => {
      commit();
      setFocused(false);
      setText(latest.current.value);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && state.current.dirty) {
        event.preventDefault();
        event.stopPropagation();
        const draft = state.current;
        clearTimeout(draft.timer);
        pending.delete(commit);
        draft.dirty = false;
        draft.text = draft.original;
        setText(draft.text);
      } else if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        commit();
      }
    },
  };
}
