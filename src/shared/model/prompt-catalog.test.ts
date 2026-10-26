import { describe, expect, it } from 'vitest';

import { connectionIn } from '../adapter';
import { OPS } from '../api/registry';
import { MADE_UP } from '../test-made-up';
import { PromptDescriptor } from './prompts';

describe('prompt capability declarations', () => {
  it('validates all four kinds and the separate signals promise without guessing from view or names', () => {
    const declared = {
      prompts: { approval: 'answerable', question: 'seen', plan: 'none', form: 'answerable' },
      signals: false,
    };
    expect(PromptDescriptor.parse(declared)).toEqual(declared);
    for (const invalid of [
      { ...declared, signals: undefined },
      { ...declared, signals: 'yes' },
      { ...declared, prompts: { approval: 'answerable' } },
      { ...declared, prompts: { ...declared.prompts, form: 'api' } },
      { ...declared, prompts: { ...declared.prompts, extra: 'seen' } },
    ])
      expect(PromptDescriptor.safeParse(invalid).success).toBe(false);
  });

  it('validates the catalog wire fields and reads an adapter absent from the shipping catalog', () => {
    expect(OPS['catalog.get'].output.safeParse(MADE_UP).success).toBe(true);
    const acp = connectionIn(MADE_UP, 'zed.acp')?.connection;
    const free = connectionIn(MADE_UP, 'zed.free')?.connection;
    expect(acp).toMatchObject({
      prompts: { approval: 'answerable', question: 'seen', plan: 'none', form: 'answerable' },
      signals: true,
    });
    expect(free).toMatchObject({
      prompts: { approval: 'none', question: 'none', plan: 'none', form: 'none' },
      signals: false,
    });
    const invalid = structuredClone(MADE_UP);
    Reflect.deleteProperty(invalid.adapters[0]?.connections[0] ?? {}, 'signals');
    expect(OPS['catalog.get'].output.safeParse(invalid).success).toBe(false);
  });
});
