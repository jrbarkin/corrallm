import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

import { MAX_LABEL } from '../shared/api/limits';
import type { GuiDraftsApi } from '../shared/gui-link';
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
 * Waits for every draft attempt; refusals belong to their fields. An action runs only afterward,
 * synchronously when no write is in flight (as flushSync applies local graph edits).
 */
export function flushDrafts(after?: () => unknown): Promise<void> {
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
  if (saving.size > 0) return Promise.allSettled([...saving]).then(() => flushDrafts(after));
  try {
    return Promise.resolve(after?.()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(ipcErrorMessage(error)));
  }
}

/** Your messages on their way to the core: a window's close waits for each to be answered. */
const sends = new Set<Promise<unknown>>();

/**
 * Sends one of your messages (an operation): the window's `drafts.flush` waits until the core has
 * answered it, so closing the window right after Send never loses it. An operation's own draft
 * flush never waits for it, so two sends never wait on each other.
 */
export function viewSend<T>(call: () => Promise<T>): Promise<T> {
  const promise = draftCall(call);
  sends.add(promise);
  const settled = () => {
    sends.delete(promise);
  };
  void promise.then(settled, settled);
  return promise;
}

/**
 * Answers the core's `drafts.flush` (main asks it before quitting, B11 Design §16.5) with
 * `flushDrafts`: what is being typed is committed, each field's operation answered, and each
 * message sent answered, before the window says it is done. A field's refusal stays the field's.
 * Returns what stops answering.
 */
export function answerDraftFlushes(api: Pick<GuiDraftsApi, 'draftsOnFlush'>): () => void {
  return api.draftsOnFlush(() =>
    flushDrafts().then(async () => {
      await Promise.allSettled([...sends]);
    }),
  );
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
    validate,
  }: {
    multiline?: boolean;
    normalize?: (text: string) => string;
    validate?: (text: string) => unknown;
  } = {},
) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [savingDraft, setSavingDraft] = useState(false);
  const latest = useRef({ value, onCommit, normalize, validate });
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
    latest.current = { value, onCommit, normalize, validate };
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
      latest.current.validate?.(draft.text);
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
      try {
        latest.current.validate?.(draft.text);
        setProblem(undefined);
      } catch (error) {
        draft.failed = true;
        setProblem(ipcErrorMessage(error));
      }
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
