import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startApiServer } from '../../api/mcp';
import type { ApiServer } from '../../api/mcp';
import type { TokenCaller } from '../caller';
import type { Core } from '../core';
import { readOnDisk, refuseWrites } from '../store/test-store';
import { CALLERS, CANVAS } from '../test-registry';
import { startWorld } from '../test-world';

/*
 * A canvas's structure, by doc ops (Core Server §4 C, B9 Design §3), end to end on the test world:
 * canvas.rename commits one revision with what it changed, through core.call and over MCP; is a
 * conflict, saying what is there now, when its caller expected another revision; changes nothing
 * when its commit fails; and answers a repeated request as it first did.
 */

const ORCHESTRATOR = CALLERS['outside-write'];
const REQUEST = '3d4e5f60-7182-4a3b-8cad-2e3f4a5b6c01';
const KEY = `canvas:${CANVAS}`;

let world: { core: Core; profile: string; close(): Promise<void> };
let server: ApiServer;
let client: Client;

beforeEach(async () => {
  world = await startWorld();
  server = await startApiServer({
    core: world.core,
    clientOf: (token) => (token === 'write-token' ? (ORCHESTRATOR as TokenCaller) : undefined),
    port: 0,
  });
  client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: 'Bearer write-token' } },
    }),
  );
  await client.listTools();
});
afterEach(async () => {
  await client.close();
  await server.close();
  await world.close();
});

/** The canvas's revisions, and what each changed, as the database keeps them. */
const revisions = () =>
  readOnDisk(world.profile, (disk) =>
    disk
      .prepare(
        `SELECT r.rev, r.op, r.by_party, r.request, c.entity, c.rev_before,
           json_extract(c.after_data, '$.label') AS label
         FROM revision r JOIN change c USING (canvas_id, rev)
         WHERE canvas_id = ? AND r.rev > 1 ORDER BY r.rev`,
      )
      .all(CANVAS),
  );
const labelOf = (node: string) =>
  world.core.engines.canvas(CANVAS)?.document.nodes.find((one) => one.id === node)?.data.label;

describe('canvas.rename', () => {
  it('commits one revision, with its change, through core.call and over MCP', async () => {
    const engine = world.core.engines.canvas(CANVAS)?.engine;
    if (!engine) throw new Error('The world’s canvas isn’t open.');
    const followed = vi.spyOn(engine, 'update');
    expect(
      await world.core.call(
        'canvas.rename',
        { canvas: CANVAS, node: 'helper', label: 'Assistant', request: REQUEST },
        ORCHESTRATOR,
      ),
    ).toEqual({ ok: true, value: { revs: { [KEY]: 2 } } });
    // The engine follows the document.
    expect(followed).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'helper',
          data: expect.objectContaining({ label: 'Assistant' }) as unknown,
        }),
      ]),
    );

    // Over MCP, naming no canvas: the token has one.
    const renamed = await client.callTool({
      name: 'canvas_rename',
      arguments: { node: 'worker', label: 'Builder', expect: { 'node/worker': 1 } },
    });
    expect(renamed.structuredContent).toEqual({ revs: { [KEY]: 3 } });
    expect(revisions()).toEqual([
      {
        rev: 2,
        op: 'canvas.rename',
        by_party: 'outside:orchestrator',
        request: REQUEST,
        entity: 'node/helper',
        rev_before: 1,
        label: 'Assistant',
      },
      {
        rev: 3,
        op: 'canvas.rename',
        by_party: 'outside:orchestrator',
        request: null,
        entity: 'node/worker',
        rev_before: 1,
        label: 'Builder',
      },
    ]);
    expect([labelOf('helper'), labelOf('worker')]).toEqual(['Assistant', 'Builder']);
  });

  it('is a conflict when its caller expected another revision, saying what is there now', async () => {
    await world.core.call('canvas.rename', { node: 'helper', label: 'Assistant' }, ORCHESTRATOR);
    const stale = await client.callTool({
      name: 'canvas_rename',
      arguments: { node: 'helper', label: 'Aide', expect: { 'node/helper': 1 } },
    });
    expect(stale.isError).toBe(true);
    const [sentence, error] = stale.content as { text: string }[];
    const sentenceText =
      'node/helper is at revision 2, not 1: it changed since you read it. Read it again before you change it.';
    expect(sentence?.text).toBe(sentenceText);
    expect(JSON.parse(error?.text ?? '')).toEqual({
      error: {
        code: 'conflict',
        sentence: sentenceText,
        current: {
          'node/helper': {
            rev: 2,
            value: expect.objectContaining({ id: 'helper', label: 'Assistant' }) as unknown,
          },
        },
      },
    });
    expect(labelOf('helper')).toBe('Assistant');
    expect(revisions()).toHaveLength(1);
  });

  it('changes nothing when its commit fails, and runs a repeated request again', async () => {
    const allow = refuseWrites(world.profile, 'node', 'The disk is full');
    const args = { node: 'helper', label: 'Assistant', request: REQUEST };
    expect(await world.core.call('canvas.rename', args, ORCHESTRATOR)).toEqual({
      ok: false,
      error: {
        code: 'unavailable',
        sentence: 'The change couldn’t be written, so nothing changed: The disk is full',
      },
    });
    expect(labelOf('helper')).toBe('Helper');
    expect(revisions()).toEqual([]);
    allow();
    expect(await world.core.call('canvas.rename', args, ORCHESTRATOR)).toEqual({
      ok: true,
      value: { revs: { [KEY]: 2 } },
    });
    expect(labelOf('helper')).toBe('Assistant');
  });

  it('answers a repeated request as it first did, committing once', async () => {
    const args = { canvas: CANVAS, node: 'helper', label: 'Assistant', request: REQUEST };
    const first = await world.core.call('canvas.rename', args, CALLERS.you);
    expect(first).toEqual({ ok: true, value: { revs: { [KEY]: 2 } } });
    expect(await world.core.call('canvas.rename', args, CALLERS.you)).toEqual(first);
    // Not the same request, it changes nothing: the helper is called so already.
    expect(
      await world.core.call('canvas.rename', { ...args, request: undefined }, CALLERS.you),
    ).toEqual({ ok: true, value: { revs: {} } });
    expect(revisions()).toHaveLength(1);
  });

  it('refuses a node there isn’t, changing nothing', async () => {
    expect(
      await world.core.call('canvas.rename', { node: 'ghost', label: 'Boo' }, CALLERS.you),
    ).toEqual({ ok: false, error: { code: 'not-found', sentence: 'There is no node ghost.' } });
    expect(revisions()).toEqual([]);
  });
});
