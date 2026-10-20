import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

import { MAX_LABEL } from '../shared/api/limits';
import { ipcErrorMessage } from './ipc-error';

const IDLE_MS = 600;
const pending = new Set<() => unknown>();
const saving = new Set<Promise<unknown>>();
let flushing = false;
let committing: Set<Promise<unknown>> | undefined;
let fields = 0;

/** A void UI callback still owns the operations it sends while committing a draft. */
export function draftCall<T>(call: () => Promise<T>): Promise<T> {
  const promise = call();
  committing?.add(promise);
  return promise;
}

/**
 * Waits for every draft attempt; refusals belong to their fields and never block another action.
 */
export function flushDrafts(): Promise<void> {
  // An op sent by the commit itself must not await that same commit.
  if (committing !== undefined) return Promise.resolve();
  if (!flushing && pending.size > 0) {
    flushing = true;
    try {
      flushSync(() => {
        for (const commit of [...pending]) commit();
      });
    } finally {
      flushing = false;
    }
  }
  return saving.size === 0
    ? Promise.resolve()
    : Promise.allSettled([...saving]).then(() => flushDrafts());
}

/** Pointer actions, drags and keyboard shortcuts flush before their handlers run, portals too. */
function beforeGesture(event: Event): void {
  const target = event.target instanceof Element ? event.target : undefined;
  if (event instanceof globalThis.KeyboardEvent) {
    if (event.isComposing || target?.closest('input, textarea, [contenteditable]')) return;
  } else if (target?.closest('[data-draft]') === document.activeElement) return;
  void flushDrafts().catch((error: unknown) => {
    console.error('Could not flush drafts:', ipcErrorMessage(error));
  });
}

/** A field's local text: failed drafts stay until corrected or abandoned with Escape. */
export function useDraft(
  value: string,
  onCommit: (text: string) => unknown,
  {
    multiline = false,
    normalize,
  }: { multiline?: boolean; normalize?: (text: string) => string } = {},
) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [savingDraft, setSavingDraft] = useState(false);
  const latest = useRef({ value, onCommit, normalize });
  const state = useRef({
    dirty: false,
    failed: false,
    version: 0,
    original: value,
    text: value,
    inflight: undefined as Promise<boolean> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useLayoutEffect(() => {
    latest.current = { value, onCommit, normalize };
  });
  useLayoutEffect(() => {
    const draft = state.current;
    if (draft.dirty || draft.failed || draft.inflight !== undefined) return;
    draft.text = draft.original = value;
    setText(value);
  }, [value]);

  const commit = useCallback(function commit(): boolean | Promise<boolean> {
    const draft = state.current;
    clearTimeout(draft.timer);
    pending.delete(commit);
    if (!draft.dirty) return draft.inflight ?? !draft.failed;
    draft.dirty = false;
    const { version } = draft;
    const finish = (error?: { reason: unknown }): boolean => {
      if (draft.version === version) {
        draft.inflight = undefined;
        draft.failed = error !== undefined;
        if (error === undefined) draft.original = draft.text;
        setProblem(error === undefined ? undefined : ipcErrorMessage(error.reason));
        setSavingDraft(false);
      }
      return error === undefined && draft.version === version;
    };
    const calls = new Set<Promise<unknown>>();
    const previous = committing;
    committing = calls;
    let failure: { reason: unknown } | undefined;
    try {
      if (latest.current.normalize) {
        draft.text = latest.current.normalize(draft.text);
        setText(draft.text);
      }
      const changed = draft.text !== draft.original && draft.text !== latest.current.value;
      if (!changed) return finish();
      const result = latest.current.onCommit(draft.text);
      if (result instanceof Promise) calls.add(result);
    } catch (reason) {
      failure = { reason };
    } finally {
      committing = previous;
    }
    if (calls.size === 0) return finish(failure);
    setSavingDraft(true);
    const work = Promise.allSettled(calls).then((results) =>
      finish(failure ?? results.find((result) => result.status === 'rejected')),
    );
    draft.inflight = work;
    saving.add(work);
    void work.then(() => saving.delete(work));
    return work;
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
      draft.version++;
      if (--fields === 0) {
        for (const type of ['pointerdown', 'click', 'dragstart', 'drop', 'keydown'])
          document.removeEventListener(type, beforeGesture, true);
        window.removeEventListener('beforeunload', beforeGesture);
      }
    };
  }, [commit]);

  return {
    problem,
    'data-draft': '',
    'aria-invalid': problem !== undefined,
    value: focused || problem !== undefined || savingDraft ? text : value,
    onFocus: () => {
      const draft = state.current;
      setFocused(true);
      if (draft.dirty || draft.failed || draft.inflight !== undefined) return;
      draft.original = draft.text = latest.current.value;
      setText(draft.text);
    },
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const draft = state.current;
      draft.version++;
      draft.dirty = true;
      draft.failed = false;
      draft.inflight = undefined;
      draft.text = event.target.value;
      setSavingDraft(false);
      setFocused(true);
      setText(draft.text);
      setProblem(undefined);
      clearTimeout(draft.timer);
      pending.add(commit);
      draft.timer = setTimeout(() => {
        void commit();
      }, IDLE_MS);
    },
    onBlur: () => {
      const kept = commit();
      setFocused(false);
      return kept;
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      const draft = state.current;
      if (event.key === 'Escape' && (draft.dirty || draft.failed || draft.inflight !== undefined)) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(draft.timer);
        pending.delete(commit);
        draft.version++;
        draft.dirty = draft.failed = false;
        draft.inflight = undefined;
        draft.text = draft.original = latest.current.value;
        setText(draft.text);
        setProblem(undefined);
        setSavingDraft(false);
        return true;
      } else if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        return commit();
      }
      return undefined;
    },
  };
}

/** Canvas labels obey the file’s bounds, with blank edits restoring the saved label. */
export function useLabel(value: string, onCommit: (text: string) => unknown) {
  return {
    ...useDraft(value, onCommit, {
      normalize: (text) => {
        const bounded = text.slice(0, MAX_LABEL).replace(/[\uD800-\uDBFF]$/, '');
        return bounded.trim() ? bounded : value;
      },
    }),
    maxLength: MAX_LABEL,
  };
}
