import { describe, expect, it } from 'vitest';

import { engineCatalog, fileMentionRefusal, hasFileMention } from './catalog';
import { MADE_UP } from '../test-made-up';

describe('native file mentions', () => {
  it.each([
    '@/x',
    '@../x',
    '@"a b"',
    '@~/x',
    '@link',
    '@src/x#L2-3',
    '(@x)',
    'Read @x',
    'Read\n@x',
    '_@x',
    '🙂@x',
    '¼@x',
    'Ⅳ@x',
    'é@x',
    '９@x',
  ])('recognizes %s as a mention', (text) => {
    expect(hasFileMention(text)).toBe(true);
  });
  it.each(['a@b.com', 'a@/x', '@ ', '@\n', '@', 'Read x'])('leaves %s as ordinary text', (text) => {
    expect(hasFileMention(text)).toBe(false);
  });

  it('reads file-mention behavior from any adapter’s connection', () => {
    const catalog = structuredClone(MADE_UP);
    const connection = catalog.adapters[0]?.connections[0];
    if (!connection) throw new Error('The fixture needs a connection');
    Object.assign(connection, { fileMentions: true });
    const engine = engineCatalog(catalog, 'zed');
    expect(engine.fileMentions('zed.acp')).toBe(true);
    expect(engine.fileMentions('zed.free')).toBe(false);
    expect(engine.fileMentions('unavailable')).toBe(false);
    expect(fileMentionRefusal(engine, 'zed.acp', 'Read @link')).toContain('Zed Agent · ACP');
    expect(fileMentionRefusal(engine, 'zed.free', 'Read @link')).toBeUndefined();
  });
});
