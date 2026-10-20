import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

import { ipcErrorMessage } from './ipc-error';

const IDLE_MS = 600;
const pending = new Set<() => void>();
const saving = new Set<Promise<unknown>>();
let flushing = false;
let committing = false;
let fields = 0;

function remember(promise: Promise<unknown>): void {
  if (saving.has(promise)) return;
  saving.add(promise);
  void promise.then(
    () => saving.delete(promise),
    (error: unknown) => {
      saving.delete(promise);
      draftFailed(error);
    },
  );
}

/** A void UI callback still owns the operations it sends while committing a draft. */
export function draftCall<T>(call: () => Promise<T>): Promise<T> {
  const promise = call();
  if (committing) remember(promise);
  return promise;
}

/** Commits the window's pending text before another gesture reads the graph or starts work. */
export function flushDrafts(): Promise<void> {
  // An op sent by the commit itself must not await that same commit.
  if (committing) return Promise.resolve();
  if (!flushing && pending.size > 0) {
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
  return saving.size === 0 ? Promise.resolve() : Promise.all([...saving]).then(() => flushDrafts());
}

/** Pointer actions, drags and keyboard shortcuts flush before their handlers run, portals too. */
function beforeGesture(event: Event): void {
  const target = event.target instanceof Element ? event.target : undefined;
  if (event instanceof globalThis.KeyboardEvent) {
    if (event.isComposing || target?.closest('input, textarea, [contenteditable]')) return;
  } else if (target?.closest('[data-draft]') === document.activeElement) return;
  void flushDrafts().catch(draftFailed);
}

function draftFailed(error: unknown): void {
  console.error('Could not commit the draft:', ipcErrorMessage(error));
}

/** A field's local text: leave, single-line Enter or a pause commits; Escape drops the draft. */
export function useDraft(
  value: string,
  onCommit: (text: string) => unknown,
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
    if (changed) {
      committing = true;
      try {
        const result = latest.current.onCommit(draft.text);
        if (result instanceof Promise) remember(result);
      } finally {
        committing = false;
      }
    }
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
