import { describe, expect, it } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import { ConversationClaims } from './claims';

const ID = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e31';
const OTHER = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e32';
const canvas = newCanvasId();
const another = newCanvasId();

describe('ConversationClaims', () => {
  it('lets one agent’s session hold a conversation: another’s, on this canvas or another, is refused', () => {
    const claims = new ConversationClaims();
    const a = { canvas, agent: 'a', generation: 1 };
    expect(claims.claim('claude-code', ID, a)).toEqual({ ok: true });
    for (const owner of [
      { canvas, agent: 'b', generation: 2 },
      { canvas: another, agent: 'a', generation: 3 },
    ]) {
      expect(claims.claim('claude-code', ID, owner)).toEqual({ ok: false, holder: a });
    }
    expect(claims.holder('claude-code', ID)).toEqual(a);
    // By adapter and id alone: another adapter's conversation of that id is another.
    expect(claims.claim('codex', ID, { canvas, agent: 'b', generation: 2 })).toEqual({ ok: true });
    claims.release(a);
    expect(claims.claim('claude-code', ID, { canvas, agent: 'b', generation: 2 })).toEqual({
      ok: true,
    });
  });

  it('gives an agent’s conversation to its next session, and a late release of the earlier none of it', () => {
    const claims = new ConversationClaims();
    const first = { canvas, agent: 'a', generation: 1 };
    const next = { canvas, agent: 'a', generation: 2 };
    claims.claim('codex', ID, first);
    expect(claims.claim('codex', ID, next)).toEqual({ ok: true });
    // The earlier session closing late releases nothing of its replacement's, nor takes it back.
    claims.release(first);
    expect(claims.holder('codex', ID)).toEqual(next);
    expect(claims.claim('codex', ID, first)).toEqual({ ok: false, holder: next });
  });

  it('keeps the conversation a session runs now as it releases the one it ran before', () => {
    const claims = new ConversationClaims();
    const owner = { canvas, agent: 'a', generation: 1 };
    claims.claim('claude-code', ID, owner);
    claims.claim('claude-code', OTHER, owner);
    claims.release(owner, { adapter: 'claude-code', id: OTHER });
    expect(claims.holder('claude-code', ID)).toBeUndefined();
    expect(claims.holder('claude-code', OTHER)).toEqual(owner);
  });

  it.each(['', '--resume', '-x', 'a b', 'a/b', 'x'.repeat(129)])(
    'refuses %j, which is no native conversation id',
    (id) => {
      const claims = new ConversationClaims();
      const owner = { canvas, agent: 'a', generation: 1 };
      expect(() => claims.claim('codex', id, owner)).toThrow(/Invalid codex conversation id/);
      expect(() => claims.reserve('codex', id, owner)).toThrow(/Invalid codex conversation id/);
      expect(claims.holder('codex', id)).toBeUndefined();
    },
  );

  it('reserves a conversation for an agent’s next session, which takes it over; letting go drops reservations alone', () => {
    const claims = new ConversationClaims();
    const reservation = { canvas, agent: 'a', generation: 5 };
    const running = { canvas, agent: 'b', generation: 6 };
    claims.reserve('claude-code', ID, reservation);
    claims.claim('claude-code', OTHER, running);
    expect(claims.claim('claude-code', ID, { canvas, agent: 'b', generation: 7 })).toEqual({
      ok: false,
      holder: reservation,
    });
    claims.unreserve(canvas);
    expect(claims.holder('claude-code', ID)).toBeUndefined();
    // A session's own claim stays until that session has closed.
    expect(claims.holder('claude-code', OTHER)).toEqual(running);
    claims.reserve('claude-code', ID, reservation);
    const session = { canvas, agent: 'a', generation: 8 };
    expect(claims.claim('claude-code', ID, session)).toEqual({ ok: true });
    claims.unreserve(canvas, { agent: 'a' });
    expect(claims.holder('claude-code', ID)).toEqual(session);
  });

  it('keeps one reservation per agent and adapter: a newer one lets the earlier go, never a session’s claim', () => {
    const claims = new ConversationClaims();
    const third = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e33';
    const session = { canvas, agent: 'a', generation: 1 };
    claims.claim('claude-code', third, session);
    claims.reserve('claude-code', ID, { canvas, agent: 'a', generation: 2 });
    claims.reserve('codex', ID, { canvas, agent: 'a', generation: 3 });
    // Another canvas's agent of that id is another agent: its reservation leaves a's alone.
    claims.reserve('claude-code', OTHER, { canvas: another, agent: 'a', generation: 4 });
    expect(claims.holder('claude-code', ID)?.generation).toBe(2);
    // Refused, a's newer reservation lets nothing go.
    expect(claims.reserve('claude-code', OTHER, { canvas, agent: 'a', generation: 5 }).ok).toBe(
      false,
    );
    expect(claims.holder('claude-code', ID)?.generation).toBe(2);
    claims.unreserve(another);
    const later = { canvas, agent: 'a', generation: 6 };
    expect(claims.reserve('claude-code', OTHER, later)).toEqual({ ok: true });
    expect(claims.holder('claude-code', ID)).toBeUndefined();
    expect(claims.holder('claude-code', OTHER)).toEqual(later);
    // Its session's claim and its other adapter's reservation stay.
    expect(claims.holder('claude-code', third)).toEqual(session);
    expect(claims.holder('codex', ID)?.generation).toBe(3);
  });
});
