import { describe, expect, it } from 'vitest';

import type { ArgsOf } from '../../shared/api/registry';
import type { CanvasDocument } from '../../shared/model/canvas';
import { engineCatalog } from '../../shared/model/catalog';
import { MADE_UP, TWO_MADE_UP as TWO } from '../../shared/test-made-up';
import type { TokenCaller } from './caller';
import type { Engines } from './engines';
import { ruleChecks } from './rules';
import { CALLERS, CANVAS } from './test-registry';

/*
 * R1 (`shell-text`) over the one resolver (B12 C2, §11.3): a token's text to an agent is checked
 * against the connection that agent runs. An unchosen agent runs none yet, so text starting with
 * any connection's shell prefix the catalog declares is refused, whichever adapter is first.
 */

const DOCUMENT: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [
    { id: 'unchosen', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Unchosen' } },
    {
      id: 'missing',
      type: 'agent',
      position: { x: 0, y: 100 },
      data: { label: 'Missing', adapter: 'gone' },
    },
    {
      id: 'quiet',
      type: 'agent',
      position: { x: 0, y: 200 },
      data: { label: 'Quiet', adapter: 'yak', connection: 'yak.free' },
    },
    {
      id: 'shell',
      type: 'agent',
      position: { x: 0, y: 300 },
      data: { label: 'Shell', connection: 'yak.terminal' },
    },
    {
      id: 'zed',
      type: 'agent',
      position: { x: 0, y: 400 },
      data: { label: 'Zed', adapter: 'zed' },
    },
  ],
  links: [],
};

/** The canvas the rule reads: its document, and an engine whose lookups once had a default. */
const ENGINES = {
  canvas: (canvas: string) =>
    canvas === CANVAS ? { document: DOCUMENT, engine: { catalog: engineCatalog(TWO) } } : undefined,
} as unknown as Engines;

describe('R1 over the resolver (B12 C2)', () => {
  const check = ruleChecks(ENGINES, TWO)['shell-text'].message;
  const caller = CALLERS['outside-write'] as TokenCaller;
  const send = (to: string, body: string) =>
    check({ canvas: CANVAS, to, body } as unknown as ArgsOf<'message'>, {
      caller,
      party: 'outside-write',
    });

  it('refuses a token’s text to an unchosen agent starting with any catalog prefix', async () => {
    expect(await send('unchosen', '$ ls')).toEqual({
      refuse:
        'It starts with "$", which an agent may run as a shell command without asking, and Unchosen has no agent chosen yet: only the user may send that.',
    });
    expect(await send('unchosen', '  $ls')).toMatchObject({
      refuse: expect.stringContaining('"$"') as string,
    });
    // Nor to one that runs what this build lacks.
    expect(await send('missing', '$ ls')).toMatchObject({
      refuse: expect.stringContaining('Missing runs none this build has') as string,
    });
    // Other text goes.
    expect(await send('unchosen', 'list the files')).toBeUndefined();
  });

  it('checks a known agent against its own connection alone', async () => {
    expect(await send('quiet', '$ ls')).toBeUndefined();
    expect(await send('zed', '$ ls')).toBeUndefined();
    // Named by its connection alone, it runs that connection's adapter.
    expect(await send('shell', '$ ls')).toEqual({
      refuse: expect.stringContaining('Yak Agent · Terminal') as string,
    });
  });
});

describe('file mentions over the resolver', () => {
  const caller = CALLERS['outside-write'] as TokenCaller;
  const send = (to: string, body: string, catalog = TWO) =>
    ruleChecks(ENGINES, catalog)['file-mentions'].message(
      { canvas: CANVAS, to, body } as unknown as ArgsOf<'message'>,
      { caller, party: 'outside-write' },
    );

  it.each([
    ['unchosen', 'Unchosen has no agent chosen yet'],
    ['missing', 'Missing runs none this build has'],
  ])('checks every catalog connection for mentions sent to %s agents', async (to, reason) => {
    // The engine's old default is Zed, which expands no mention. The catalog's other adapter
    // still declares one: neither an unchosen nor an unavailable endpoint consumes that default.
    expect(await send(to, 'Read @src/x')).toEqual({
      refuse: `Not sent: it contains a file mention, which an agent may read without asking, and ${reason}: only the user may send that.`,
    });
    expect(await send(to, 'mail a@b.com')).toBeUndefined();
    expect(await send(to, 'Read @src/x', MADE_UP)).toBeUndefined();
  });

  it('checks a known agent’s mentions against its own connection alone', async () => {
    expect(await send('quiet', 'Read @src/x')).toBeUndefined();
    expect(await send('zed', 'Read @src/x')).toBeUndefined();
    expect(await send('shell', 'Read @src/x')).toEqual({
      refuse: expect.stringContaining('Yak Agent · Terminal') as string,
    });
  });
});
