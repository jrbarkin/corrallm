import { useEffect, useRef, useState } from 'react';

import type { PastSession } from '../../shared/session';
import { ipcErrorMessage } from '../ipc-error';
import { SearchPicker } from '../search/SearchPicker';

/**
 * /resume for an Agent SDK agent, above its composer: the conversations Claude Code kept for the
 * project folder (but the agent's own), most recent first, to type to search and pick from, each
 * with when it last changed, its size and its branch ("Fix the login bug · 3 days ago · 1.2 MB ·
 * main"). The one picked opens in this agent (`onPick`); Esc closes it.
 */
export function ResumePicker({
  list,
  onPick,
  onClose,
}: {
  /** The conversations, from main (session:list). */
  list: () => Promise<PastSession[]>;
  /** Opens one in the agent; rejects saying why it could not. */
  onPick: (session: PastSession) => Promise<void>;
  onClose: () => void;
}) {
  const [found, setFound] = useState<PastSession[]>();
  const [problem, setProblem] = useState<string>();
  const [opening, setOpening] = useState(false);
  /** Listed once, when it opens. */
  const listed = useRef(list);
  useEffect(() => {
    let current = true;
    listed.current().then(
      (sessions) => {
        if (current) setFound(sessions.filter((session) => !session.current));
      },
      (error: unknown) => {
        if (current) setProblem(ipcErrorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const pick = (session: PastSession) => {
    setOpening(true);
    onPick(session).then(onClose, (error: unknown) => {
      setOpening(false);
      setProblem(ipcErrorMessage(error));
    });
  };

  const closing = (text: string, alert = false) => (
    <>
      <p {...(alert ? { role: 'alert' } : {})}>{text}</p>
      <button type="button" autoFocus onClick={onClose}>
        Close
      </button>
    </>
  );
  return (
    <div
      className="agent-offer agent-resume"
      role="group"
      aria-label="Resume"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Only the picker closes, not the view.
        event.stopPropagation();
        onClose();
      }}
    >
      {problem !== undefined ? (
        closing(problem, true)
      ) : found === undefined ? (
        <p>Looking for this folder’s conversations…</p>
      ) : found.length === 0 ? (
        closing('No other conversations in this project folder yet.')
      ) : opening ? (
        <p>Opening the conversation…</p>
      ) : (
        <SearchPicker
          label="Resume a conversation"
          options={found}
          optionLabel={(session) => session.title}
          optionDetail={(session) => detail(session, Date.now())}
          optionKey={(session) => session.id}
          placeholder="Search conversations…"
          onPick={pick}
          onCancel={onClose}
        />
      )}
    </div>
  );
}

/** "2 hours ago · 24 KB · main": when it last changed, how large it is, and its branch. */
function detail(session: PastSession, now: number): string {
  return [
    ago(session.modified, now),
    ...(session.bytes === undefined ? [] : [size(session.bytes)]),
    ...(session.branch === undefined ? [] : [session.branch]),
  ].join(' · ');
}

/** How long ago a time was, in words: "just now", "5 minutes ago", "yesterday", "3 days ago". */
function ago(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  const plural = (count: number, unit: string) =>
    `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return plural(days, 'day');
  return new Date(then).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** A size in bytes, as a file browser shows it: "820 bytes", "24 KB", "1.2 MB". */
function size(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} bytes`;
  if (bytes < 1_000_000) return `${String(Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
