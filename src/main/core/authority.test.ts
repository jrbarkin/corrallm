import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOKEN_REPLACED } from '../../shared/api/errors';
import type { CanvasId } from '../../shared/canvas';
import { FakeConnector } from '../sessions/fake';
import type { OutsideCaller } from './caller';
import { createCore } from './core';
import type { Core } from './core';
import { SYSTEM_DEPS } from './store/store';
import { keepCanvases } from './store/test-store';
import { NO_DESKTOP } from './test-registry';
import { legacyDirectories } from './workspaces/test-directories';

/*
 * The authority stamp (B21 §9 C2), composed in the real core: a caller a token identifies holds
 * its authority only while that token works, checked at every seam core.call checks its audience,
 * so a call admitted before its token ended, and still waiting, is refused when it runs.
 */

const M1 = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a31' as CanvasId;

let profile: string;
let core: Core | undefined;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-authority-'));
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await rm(profile, { recursive: true, force: true });
});

/** A kept canvas with one App Server agent, Builder, as the app would keep it with its folder. */
async function keep(): Promise<void> {
  const file = path.join(profile, 'm1.corral');
  const project = path.join(profile, 'm1');
  await mkdir(project, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      format: 'corrallm',
      version: 2,
      id: M1,
      nodes: [
        {
          id: 'builder',
          kind: 'agent',
          label: 'Builder',
          position: { x: 0, y: 0 },
          adapter: 'codex',
          connection: 'codex.app-server',
        },
      ],
      links: [],
    }),
  );
  await keepCanvases(profile, { [M1]: { file, project } });
}

/**
 * Starts a core whose database's log flushes wait, while `held` is set, until it is released: a
 * write going on then holds its scope.
 */
async function start(): Promise<{ hold: () => () => void }> {
  let held: Promise<void> | undefined;
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1.0.0' },
      check: true,
      distribution: 'local',
      directoryResolver: legacyDirectories,
      locale: 'en-GB',
      store: {
        ...SYSTEM_DEPS,
        flush: async (fd) => {
          await held;
          return SYSTEM_DEPS.flush(fd);
        },
      },
      sessions: {
        connectors: { 'codex.app-server': new FakeConnector({ adapter: 'codex' }) },
        environment: () => Promise.resolve({}),
      },
    },
    NO_DESKTOP,
  );
  await core.engines.open(M1);
  return {
    hold: () => {
      const release = Promise.withResolvers<undefined>();
      held = release.promise.then(() => undefined);
      return () => {
        held = undefined;
        release.resolve(undefined);
      };
    },
  };
}

function current(): Core {
  if (!core) throw new Error('No core is started');
  return core;
}

/** An outside write token's caller, made as `corrallm serve --new-token` makes it. */
async function token(name = 'orchestrator'): Promise<OutsideCaller> {
  const made = await current().tokens.create({ name, canvases: [M1], access: 'write' });
  const caller = current().clientOf(made);
  if (caller?.kind !== 'outside') throw new Error('The token names no outside caller');
  return caller;
}

/** The bodies of the messages a party sent on the canvas. */
function sentBy(party: string): string[] {
  return (current().engines.canvas(M1)?.messages.all() ?? [])
    .filter((message) => message.from === party)
    .map((message) => message.body);
}

describe('an outside token’s authority', () => {
  it.each(['revoke', 'renew'] as const)(
    'ends with its token (%s): a call admitted before, queued in a scope, is refused when it runs',
    async (how) => {
      await keep();
      const { hold } = await start();
      const caller = await token();
      const release = hold();
      // The first message holds Builder's scope, waiting for its write to reach the disk.
      const first = current().call('message', { canvas: M1, to: 'builder', body: 'First' }, caller);
      // The second is admitted, and waits in that scope behind it.
      const second = current().call(
        'message',
        { canvas: M1, to: 'builder', body: 'Second' },
        caller,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (how === 'revoke') expect(await current().tokens.revoke('orchestrator')).toBe(true);
      else expect(await current().tokens.renew('orchestrator')).toBeDefined();
      release();
      await first;
      expect(await second).toEqual({
        ok: false,
        error: { code: 'refused', sentence: TOKEN_REPLACED },
      });
      expect(sentBy('outside:orchestrator')).not.toContain('Second');
    },
  );

  it('ends as its token expires, for a call waiting in a scope', async () => {
    await keep();
    // A token kept with a second to go, as tokens.json would hold one made an hour ago.
    const made = 'a-token-about-to-expire-0123456789abcdef';
    const expires = Date.now() + 1000;
    await writeFile(
      path.join(profile, 'tokens.json'),
      JSON.stringify({
        version: 2,
        tokens: {
          [createHash('sha256').update(made).digest('hex')]: {
            id: 'expiring',
            name: 'orchestrator',
            canvases: [M1],
            access: 'write',
            expires,
          },
        },
      }),
    );
    const { hold } = await start();
    const caller = current().clientOf(made);
    if (caller?.kind !== 'outside') throw new Error('No outside caller');
    const release = hold();
    const first = current().call('message', { canvas: M1, to: 'builder', body: 'First' }, caller);
    const second = current().call('message', { canvas: M1, to: 'builder', body: 'Second' }, caller);
    // The token expires while its call waits.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now()) + 50));
    release();
    await first;
    expect(await second).toEqual({
      ok: false,
      error: { code: 'refused', sentence: TOKEN_REPLACED },
    });
    expect(sentBy('outside:orchestrator')).not.toContain('Second');
  });
});
