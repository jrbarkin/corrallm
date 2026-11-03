import { describe, expect, it } from 'vitest';

import type { ConnectionDescriptor } from './adapter';
import {
  allowsMcpChange,
  allowsRewind,
  declaredFeatures,
  effectiveFeatures,
  NO_FEATURES,
  usableFeatures,
} from './features';
import type { FeatureMethods } from './features';
import { MADE_UP } from './test-made-up';

/** Every method a generation could have. */
const ALL: FeatureMethods = {
  setEffort: true,
  stopTask: true,
  mcpServers: true,
  changeMcpServer: true,
  rewindFiles: true,
  listConversations: true,
  forkConversation: true,
};
const NONE: FeatureMethods = Object.fromEntries(
  Object.keys(ALL).map((key) => [key, false]),
) as unknown as FeatureMethods;

/** A connection declaring every live control and panel. */
const EVERYTHING: Pick<ConnectionDescriptor, 'live' | 'panels'> = {
  live: { effort: true, stopTask: true },
  panels: {
    resume: true,
    mcp: { changes: ['enable', 'reconnect'] },
    rewind: { restores: ['code', 'both', 'conversation'] },
  },
};

describe('effective features', () => {
  const max = { role: 'append-new', resume: true, list: false } as const;

  it('takes a report within its adapter’s maxima as it is, and a narrower one narrower', () => {
    expect(effectiveFeatures({ role: 'append-new', resume: true, list: false }, max)).toEqual(max);
    expect(effectiveFeatures({ role: 'none', resume: false, list: false }, max)).toEqual(
      NO_FEATURES,
    );
  });

  it('never advertises more than the adapter declares, nor listing without resuming', () => {
    expect(effectiveFeatures({ role: 'append', resume: true, list: true }, max)).toEqual(max);
    expect(
      effectiveFeatures(
        { role: 'append', resume: false, list: true },
        { role: 'append', resume: true, list: true },
      ),
    ).toEqual({ role: 'append', resume: false, list: false });
    expect(declaredFeatures({ role: 'append', resume: false, list: true })).toEqual({
      role: 'append',
      resume: false,
      list: false,
    });
  });

  it.each([
    ['nothing', undefined],
    ['no role', { resume: true, list: false }],
    ['an unknown role', { role: 'replace', resume: true, list: false }],
    ['a role that is not text', { role: 1, resume: true, list: false }],
    ['a resume that is not a boolean', { role: 'append', resume: 'yes', list: false }],
    ['no list', { role: 'append', resume: true }],
  ])('refuses a report with %s', (_what, report) => {
    expect(effectiveFeatures(report, max)).toBeUndefined();
  });

  it('reads an unfamiliar adapter’s maxima from its descriptor alone', () => {
    const [zed] = MADE_UP.adapters;
    expect(zed && declaredFeatures(zed)).toEqual(NO_FEATURES);
  });
});

describe('usable features', () => {
  const effective = { role: 'append', resume: true, list: true } as const;

  it('keeps every declared control a generation has the methods for, in the platform’s order', () => {
    expect(usableFeatures(effective, EVERYTHING, ALL)).toEqual({
      ...effective,
      live: { effort: true, stopTask: true },
      panels: {
        resume: true,
        mcp: { changes: ['reconnect', 'enable'] },
        rewind: { restores: ['both', 'conversation', 'code'] },
      },
    });
  });

  it('offers nothing a connection doesn’t declare, whatever methods it has', () => {
    const plain = { live: { effort: false, stopTask: false }, panels: {} };
    expect(usableFeatures(effective, plain, ALL)).toEqual({
      ...effective,
      live: { effort: false, stopTask: false },
      panels: {},
    });
  });

  it('offers nothing declared that the generation has no method for', () => {
    expect(usableFeatures(effective, EVERYTHING, NONE)).toEqual({
      ...effective,
      live: { effort: false, stopTask: false },
      panels: {},
    });
  });

  it('lists MCP servers read-only without the method that changes them', () => {
    const features = usableFeatures(effective, EVERYTHING, { ...ALL, changeMcpServer: false });
    expect(features.panels.mcp).toEqual({ changes: [] });
    expect(allowsMcpChange(features, 'enable')).toBe(false);
  });

  it('restores a conversation without a file method, and files without a fork', () => {
    const conversation = usableFeatures(effective, EVERYTHING, { ...ALL, rewindFiles: false });
    expect(conversation.panels.rewind).toEqual({ restores: ['conversation'] });
    const code = usableFeatures(effective, EVERYTHING, { ...ALL, forkConversation: false });
    expect(code.panels.rewind).toEqual({ restores: ['code'] });
    expect(allowsRewind(code, 'conversation')).toBe(false);
    expect(allowsRewind(code, 'code')).toBe(true);
    expect(allowsRewind(null, 'code')).toBe(false);
  });

  it('restores no conversation and offers no /resume where the session can’t continue one', () => {
    const features = usableFeatures(NO_FEATURES, EVERYTHING, ALL);
    expect(features.panels.rewind).toEqual({ restores: ['code'] });
    expect(features.panels.resume).toBeUndefined();
  });

  it('offers no /resume where the session resumes but can’t list', () => {
    const features = usableFeatures({ ...effective, list: false }, EVERYTHING, ALL);
    expect(features.panels.resume).toBeUndefined();
    expect(features.panels.rewind?.restores).toContain('conversation');
  });
});
