import { JOBS } from '../adapter';
import { MADE_UP } from '../test-made-up';
import { compileExample } from './test-template';
import { fromFile, toFile } from './file';
import { expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { TEST_CATALOG } from '../test-model';
import { templateInfo } from '../templates';

it('ships only neutral template definitions and descriptions', () => {
  const banned = /claude|codex|anthropic|openai|chatgpt/i;
  const slash = TEST_CATALOG.adapters.flatMap((a) =>
    a.actions.filter((action) => action.name.startsWith('/')).map((action) => action.name),
  );
  const names = TEST_CATALOG.adapters.flatMap((a) => [a.id, a.name]);
  for (const example of EXAMPLES) {
    const file: unknown = JSON.parse(example.text);
    expect(file).toMatchObject({ format: 'corrallm-template', version: 1 });
    expect(example.text).not.toMatch(
      /"(?:adapter|connection|action|settings|fallback|handoff)"\s*:/,
    );
    const text = JSON.stringify(example);
    expect(text).not.toMatch(banned);
    for (const name of [...names, ...slash])
      expect(text.toLowerCase()).not.toContain(name.toLowerCase());
  }
});
it('lists every template role without an adapter', () => {
  for (const example of EXAMPLES)
    for (const role of templateInfo(example).agents) expect(role).not.toHaveProperty('adapter');
});

it('compiles all ten templates on an unfamiliar adapter implementing their jobs', () => {
  const catalog = {
    ...MADE_UP,
    adapters: MADE_UP.adapters.map((adapter) => ({
      ...adapter,
      actions: JOBS.map((job) => ({ name: `do-${job}`, description: '', job })),
    })),
  };
  for (const example of EXAMPLES) {
    const document = compileExample(example, catalog, 'zed');
    expect(fromFile(toFile(document), catalog), example.name).toEqual(document);
    for (const node of document.nodes)
      if (node.type === 'agent')
        expect(node.data).toMatchObject({ adapter: 'zed', connection: 'zed.acp' });
  }
});
