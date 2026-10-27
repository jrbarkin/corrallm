import type { NeedsItem } from '../../shared/model/needs';
import { MAX_NOTIFICATION_BODY_BYTES } from './presence';

/*
 * What an OS notification may say (B14 §9 C8): a fixed title, and a body worded by the core from a
 * fixed sentence for its kind, carrying at most an agent's or a canvas's name. Never a prompt's
 * title, summary or detail, a command, path, URL, message, plan, form, question, error, token or
 * party name: a length cap is no secret filter, and prompts' titles carry commands. A name is
 * itself untrusted (a token may name an agent), so it is cleaned to a closed character set rather
 * than escaped (Linux notification servers render markup Electron doesn't escape: F6) and capped.
 */

export const NOTIFICATION_TITLE = 'corrallm';
/** A name's cap, in UTF-8 bytes, ellipsis included. */
export const MAX_NAME_BYTES = 32;
/** A rollup counts at most this many, then says "+". */
const MAX_COUNT = 9999;

/** What a notification is about, with the raw names it carries (cleaned as it is worded). */
export type NotificationSubject =
  /** A session's prompt (a stalled turn's question too): "{agent} is asking you something". */
  | { kind: 'prompt'; agent: string }
  /** A hold of the run's for an agent: "{agent} is waiting for you". */
  | { kind: 'hold'; agent: string }
  /** A session that won't start: "{agent} couldn’t start". */
  | { kind: 'start'; agent: string }
  /** A worktree's setup card: "A worktree’s setup is waiting for you". */
  | { kind: 'setup' }
  /** A token's proposal, or a workspace change's Switch: "A change on {canvas} needs your answer". */
  | { kind: 'proposal'; canvas: string | null }
  /** A canvas file changed on disk: "{canvas} changed on disk". */
  | { kind: 'file'; canvas: string | null }
  /** Anything else for you on a canvas, a canvas-wide hold among them: "{canvas} needs you". */
  | { kind: 'canvas'; canvas: string | null }
  /** A run that was running finished, every queue done. */
  | { kind: 'finished'; canvas: string | null }
  /** A run that was running was stopped by a party. */
  | { kind: 'stopped'; canvas: string | null }
  /** Several at once: "N things need you" (one only counted: "1 thing needs you"). */
  | { kind: 'rollup'; count: number };

/** A notification's words: its fixed title and its one-line body, within the native bounds. */
export function notificationText(subject: NotificationSubject): { title: string; body: string } {
  return { title: NOTIFICATION_TITLE, body: capped(bodyOf(subject), MAX_NOTIFICATION_BODY_BYTES) };
}

function bodyOf(subject: NotificationSubject): string {
  switch (subject.kind) {
    case 'prompt':
      return `${safeName(subject.agent, 'agent')} is asking you something`;
    case 'hold':
      return `${safeName(subject.agent, 'agent')} is waiting for you`;
    case 'start':
      return `${safeName(subject.agent, 'agent')} couldn’t start`;
    case 'setup':
      return 'A worktree’s setup is waiting for you';
    case 'proposal':
      return `A change on ${canvasName(subject.canvas, 'within')} needs your answer`;
    case 'file':
      return `${canvasName(subject.canvas, 'start')} changed on disk`;
    case 'canvas':
      return `${canvasName(subject.canvas, 'start')} needs you`;
    case 'finished':
      return `The run on ${canvasName(subject.canvas, 'within')} finished`;
    case 'stopped':
      return `The run on ${canvasName(subject.canvas, 'within')} was stopped`;
    case 'rollup': {
      const count = Math.max(1, Math.trunc(subject.count));
      if (count === 1) return '1 thing needs you';
      return `${count > MAX_COUNT ? `${String(MAX_COUNT)}+` : String(count)} things need you`;
    }
  }
}

/** A canvas as the app names it: its file's name, a draft "Untitled". */
function canvasName(name: string | null, at: 'start' | 'within'): string {
  return name === null ? 'Untitled' : safeName(name, 'canvas', at);
}

/** How a Needs item's agent and canvas are named now (as the app names them). */
export interface SubjectNames {
  agent(id: string): string;
  canvas: string | null;
}

/**
 * What a Needs item is, by its kind and what its id says it is, never by its words: its title and
 * detail are another party's text (a prompt's title carries its command).
 */
export function subjectOf(
  item: Pick<NeedsItem, 'id' | 'kind' | 'agent'>,
  names: SubjectNames,
): NotificationSubject {
  const { canvas } = names;
  switch (item.kind) {
    case 'prompt':
      return item.agent === undefined
        ? { kind: 'canvas', canvas }
        : { kind: 'prompt', agent: names.agent(item.agent) };
    case 'hold':
      if (item.agent === undefined) return { kind: 'canvas', canvas };
      return item.id.startsWith('start/')
        ? { kind: 'start', agent: names.agent(item.agent) }
        : { kind: 'hold', agent: names.agent(item.agent) };
    case 'worktree':
      return item.id.startsWith('setup/') ? { kind: 'setup' } : { kind: 'proposal', canvas };
    case 'proposal':
      return { kind: 'proposal', canvas };
    case 'file':
      return { kind: 'file', canvas };
    case 'message':
      return { kind: 'canvas', canvas };
  }
}

/** Anything a name may not hold: all but letters, marks, digits, the space and - _ , ' ( ) #. */
const UNSAFE = /[^\p{L}\p{M}\p{Nd} \-_,'()#]/gu;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/**
 * A name as a notification may carry it (C8): NFC; anything but letters, marks, digits, spaces and
 * `- _ , ' ( ) #` a space (so no markup, URL punctuation, control, bidi or invisible character
 * survives); runs of spaces one; trimmed; cut at a grapheme to at most MAX_NAME_BYTES with "…".
 * Empty, it is named by what it is: "An agent", "A canvas" (lowercase within a sentence).
 */
export function safeName(
  raw: string,
  of: 'agent' | 'canvas',
  at: 'start' | 'within' = 'start',
): string {
  const clean = raw.normalize('NFC').replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim();
  const name = capped(clean, MAX_NAME_BYTES);
  if (name !== '') return name;
  const fallback = of === 'agent' ? 'An agent' : 'A canvas';
  return at === 'start' ? fallback : fallback.toLowerCase();
}

/**
 * `text` within `max` UTF-8 bytes: whole if it fits, else as many whole graphemes as fit beside
 * "…", with no space before it; none if not even one does.
 */
function capped(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const room = max - Buffer.byteLength('…', 'utf8');
  let kept = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = Buffer.byteLength(segment, 'utf8');
    if (used + size > room) break;
    kept += segment;
    used += size;
  }
  const trimmed = kept.trimEnd();
  return trimmed === '' ? '' : `${trimmed}…`;
}
