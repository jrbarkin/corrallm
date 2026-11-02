import { describe, expect, it } from 'vitest';

import type { AdapterDescriptor, Catalog } from '../adapter';
import { MADE_UP } from '../test-made-up';
import { TEST_CATALOG } from '../test-model';
import { agentEndpoint, sameEndpoint } from './catalog';

/*
 * B12 C3's one resolver (§11.3): an agent's adapter is the one it names, else the owner of a
 * connection it names that the catalog knows. With neither it is unchosen, and nothing (no
 * preference, registry order or label) chooses for it.
 */

const [ZED] = MADE_UP.adapters as [AdapterDescriptor];

/** A catalog whose one adapter offers no connection: not one a build declares, but readable. */
const BARE: Catalog = {
  adapters: [{ ...ZED, id: 'bare', connections: [] }],
  usageBackends: [],
};

describe('agentEndpoint', () => {
  it('runs an adapter the catalog has on its first connection when it names none', () => {
    expect(agentEndpoint({ adapter: 'codex' }, TEST_CATALOG)).toEqual({
      kind: 'known',
      adapter: 'codex',
      connection: 'codex.terminal',
    });
    expect(agentEndpoint({ adapter: 'zed' }, MADE_UP)).toEqual({
      kind: 'known',
      adapter: 'zed',
      connection: 'zed.acp',
    });
    // One that offers none can't run.
    expect(agentEndpoint({ adapter: 'bare' }, BARE)).toEqual({
      kind: 'unavailable',
      adapter: 'bare',
    });
  });

  it('runs a connection its adapter offers', () => {
    expect(
      agentEndpoint({ adapter: 'codex', connection: 'codex.app-server' }, TEST_CATALOG),
    ).toEqual({ kind: 'known', adapter: 'codex', connection: 'codex.app-server' });
    expect(agentEndpoint({ adapter: 'zed', connection: 'zed.free' }, MADE_UP)).toEqual({
      kind: 'known',
      adapter: 'zed',
      connection: 'zed.free',
    });
  });

  it('runs nothing on a connection its adapter doesn’t offer, keeping both as written', () => {
    expect(agentEndpoint({ adapter: 'codex', connection: 'codex.gone' }, TEST_CATALOG)).toEqual({
      kind: 'unavailable',
      adapter: 'codex',
      connection: 'codex.gone',
    });
    // Another adapter's: a file and a commit refuse it (Mismatch); read here, it runs nothing.
    expect(
      agentEndpoint({ adapter: 'codex', connection: 'claude-code.terminal' }, TEST_CATALOG),
    ).toEqual({ kind: 'unavailable', adapter: 'codex', connection: 'claude-code.terminal' });
    // A string an id may be is no sentinel.
    expect(agentEndpoint({ adapter: 'codex', connection: 'unavailable' }, TEST_CATALOG)).toEqual({
      kind: 'unavailable',
      adapter: 'codex',
      connection: 'unavailable',
    });
  });

  it('runs nothing for an adapter the catalog lacks, keeping both as written', () => {
    expect(agentEndpoint({ adapter: 'zed' }, TEST_CATALOG)).toEqual({
      kind: 'unavailable',
      adapter: 'zed',
    });
    expect(agentEndpoint({ adapter: 'zed', connection: 'zed.acp' }, TEST_CATALOG)).toEqual({
      kind: 'unavailable',
      adapter: 'zed',
      connection: 'zed.acp',
    });
    // Even with a connection the catalog knows: the adapter it names decides.
    expect(agentEndpoint({ adapter: 'zed', connection: 'codex.terminal' }, TEST_CATALOG)).toEqual({
      kind: 'unavailable',
      adapter: 'zed',
      connection: 'codex.terminal',
    });
  });

  it('runs a known connection’s adapter for an agent that names only the connection', () => {
    expect(agentEndpoint({ connection: 'codex.terminal' }, TEST_CATALOG)).toEqual({
      kind: 'known',
      adapter: 'codex',
      connection: 'codex.terminal',
    });
    expect(agentEndpoint({ connection: 'claude-code.terminal' }, TEST_CATALOG)).toEqual({
      kind: 'known',
      adapter: 'claude-code',
      connection: 'claude-code.terminal',
    });
    expect(agentEndpoint({ connection: 'zed.free' }, MADE_UP)).toEqual({
      kind: 'known',
      adapter: 'zed',
      connection: 'zed.free',
    });
  });

  it('chooses nothing for an agent naming neither, keeping an unknown connection as written', () => {
    expect(agentEndpoint({}, TEST_CATALOG)).toEqual({ kind: 'unchosen' });
    expect(agentEndpoint({}, MADE_UP)).toEqual({ kind: 'unchosen' });
    expect(agentEndpoint({ connection: 'zed.acp' }, TEST_CATALOG)).toEqual({
      kind: 'unchosen',
      connection: 'zed.acp',
    });
    expect(agentEndpoint({ connection: 'unavailable' }, TEST_CATALOG)).toEqual({
      kind: 'unchosen',
      connection: 'unavailable',
    });
    // No catalog's order makes one the default.
    expect(agentEndpoint({}, { adapters: [], usageBackends: [] })).toEqual({ kind: 'unchosen' });
  });
});

describe('sameEndpoint', () => {
  const of = (agent: { adapter?: string; connection?: string }) =>
    agentEndpoint(agent, TEST_CATALOG);

  it('reads a first connection named or not, and an adapter named or owned, as the same', () => {
    expect(sameEndpoint(of({ adapter: 'codex' }), of({ connection: 'codex.terminal' }))).toBe(true);
    expect(
      sameEndpoint(
        of({ adapter: 'codex', connection: 'codex.terminal' }),
        of({ connection: 'codex.terminal' }),
      ),
    ).toBe(true);
    expect(sameEndpoint(of({ adapter: 'zed' }), of({ adapter: 'zed' }))).toBe(true);
    expect(sameEndpoint(of({}), of({}))).toBe(true);
  });

  it('tells unchosen from every endpoint, and each as written from another', () => {
    for (const agent of [
      { adapter: 'claude-code' },
      { adapter: 'codex' },
      { connection: 'claude-code.terminal' },
      { adapter: 'zed' },
      { connection: 'zed.acp' },
    ]) {
      expect(sameEndpoint(of({}), of(agent)), JSON.stringify(agent)).toBe(false);
      expect(sameEndpoint(of(agent), of({})), JSON.stringify(agent)).toBe(false);
    }
    expect(
      sameEndpoint(of({ adapter: 'zed' }), of({ adapter: 'zed', connection: 'zed.acp' })),
    ).toBe(false);
    expect(sameEndpoint(of({ adapter: 'codex' }), of({ adapter: 'claude-code' }))).toBe(false);
  });
});
