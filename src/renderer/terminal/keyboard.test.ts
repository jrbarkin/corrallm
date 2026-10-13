import { describe, expect, it } from 'vitest';

import { isUsLike, optionIsMetaByDefault } from './keyboard';
import { keyboardLayout as layout } from './test-screen';

/** German (QWERTZ, @ on Option+L) and French (AZERTY, @ on Option+à) layouts, in part. */
const GERMAN = { KeyY: 'z', KeyZ: 'y', Minus: 'ß', Semicolon: 'ö', Quote: 'ä', BracketLeft: 'ü' };
const FRENCH = { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', KeyM: ',', Digit2: 'é' };

describe('the Option key', () => {
  it('is Meta by default only on a layout like the US one', async () => {
    expect(isUsLike(layout())).toBe(true);
    expect(isUsLike(layout(GERMAN))).toBe(false);
    expect(isUsLike(layout(FRENCH))).toBe(false);
    // One key off (a Spanish layout's ñ) is enough.
    expect(isUsLike(layout({ Semicolon: 'ñ' }))).toBe(false);

    const keyboard = (map: Map<string, string>) => ({ getLayoutMap: () => Promise.resolve(map) });
    await expect(optionIsMetaByDefault(keyboard(layout()))).resolves.toBe(true);
    await expect(optionIsMetaByDefault(keyboard(layout(GERMAN)))).resolves.toBe(false);
  });

  it('types characters when the layout cannot be known', async () => {
    await expect(optionIsMetaByDefault(undefined)).resolves.toBe(false);
    await expect(optionIsMetaByDefault({})).resolves.toBe(false);
    await expect(
      optionIsMetaByDefault({ getLayoutMap: () => Promise.reject(new Error('Not allowed')) }),
    ).resolves.toBe(false);
  });
});
