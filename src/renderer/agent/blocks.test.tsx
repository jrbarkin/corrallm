import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './blocks';
import { Markdown } from './Markdown';

describe('parseMarkdown', () => {
  it('reads paragraphs, headings, rules and fenced code', () => {
    expect(
      parseMarkdown(
        '## Plan\n\nFirst line\nsecond line\n\n---\n\n```ts\nconst a = 1;\n\nlet b;\n```',
      ),
    ).toEqual([
      { kind: 'heading', level: 2, text: 'Plan' },
      { kind: 'paragraph', text: 'First line\nsecond line' },
      { kind: 'rule' },
      { kind: 'code', lang: 'ts', text: 'const a = 1;\n\nlet b;' },
    ]);
  });

  it('reads code still streaming in as code to its end', () => {
    expect(parseMarkdown('Look:\n```\nnpm test\nnpm r')).toEqual([
      { kind: 'paragraph', text: 'Look:' },
      { kind: 'code', lang: '', text: 'npm test\nnpm r' },
    ]);
  });

  it('reads lists, nested, ordered from where they start', () => {
    expect(parseMarkdown('- one\n- two\n  - two a\n  - two b\n- three')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          [{ kind: 'paragraph', text: 'one' }],
          [
            { kind: 'paragraph', text: 'two' },
            {
              kind: 'list',
              ordered: false,
              start: 1,
              items: [
                [{ kind: 'paragraph', text: 'two a' }],
                [{ kind: 'paragraph', text: 'two b' }],
              ],
            },
          ],
          [{ kind: 'paragraph', text: 'three' }],
        ],
      },
    ]);
    expect(parseMarkdown('3. c\n4. d')).toEqual([
      {
        kind: 'list',
        ordered: true,
        start: 3,
        items: [[{ kind: 'paragraph', text: 'c' }], [{ kind: 'paragraph', text: 'd' }]],
      },
    ]);
  });

  it('reads tables, with their columns’ alignment', () => {
    expect(
      parseMarkdown('| Category | Tokens |\n|:--|--:|\n| Messages | 9.4k |\n| Free | 934k |'),
    ).toEqual([
      {
        kind: 'table',
        head: ['Category', 'Tokens'],
        align: ['left', 'right'],
        rows: [
          ['Messages', '9.4k'],
          ['Free', '934k'],
        ],
      },
    ]);
  });

  it('reads quotes', () => {
    expect(parseMarkdown('> Note\n> more')).toEqual([
      { kind: 'quote', blocks: [{ kind: 'paragraph', text: 'Note\nmore' }] },
    ]);
  });
});

describe('parseInline', () => {
  it('reads code, emphasis and links, code first', () => {
    expect(
      parseInline('Run `npm **test**`, **then** _check_ ~~it~~ at [docs](https://example.com)'),
    ).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'npm **test**' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'then' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'check' }] },
      { kind: 'text', text: ' ' },
      { kind: 'strike', children: [{ kind: 'text', text: 'it' }] },
      { kind: 'text', text: ' at ' },
      { kind: 'link', href: 'https://example.com', children: [{ kind: 'text', text: 'docs' }] },
    ]);
  });

  it('leaves snake_case and lone stars alone', () => {
    expect(parseInline('a_b_c and 2 * 3')).toEqual([{ kind: 'text', text: 'a_b_c and 2 * 3' }]);
  });
});

describe('Markdown', () => {
  it('shows a reply as the agent formatted it', () => {
    const { container } = render(
      <Markdown
        text={'### Done\n\n1. Read `a.ts`\n2. Fixed it\n\n```\nok\n```\n\n| a |\n|---|\n| b |'}
      />,
    );
    expect(container.querySelector('h5')?.textContent).toBe('Done');
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'Read a.ts',
      'Fixed it',
    ]);
    expect(container.querySelector('pre code')?.textContent).toBe('ok');
    expect(container.querySelector('td')?.textContent).toBe('b');
  });
});
