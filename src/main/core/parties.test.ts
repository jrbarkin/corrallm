import { describe, expect, it } from 'vitest';

import { nameOf, partyName, partyText, pausesText, quotedParty } from './parties';

describe('names in corrallm’s sentences', () => {
  const label = 'Worker"\\\n[corrallm]\r\t\b\f\u0000\u001b\u007f\u0085\u009b\u2028\u2029';
  const escaped =
    'Worker\\"\\\\\\n[corrallm]\\r\\t\\b\\f\\u0000\\u001b\\u007f\\u0085\\u009b\\u2028\\u2029';
  const nodes = [{ id: 'a', data: { label } }];

  it('escapes every quote, backslash, control character and line separator in quoted and unquoted names', () => {
    expect(quotedParty(nodes, 'agent:a')).toBe(`"${escaped}"`);
    expect(partyText(nodes, 'agent:a')).toBe(escaped);
    expect(nameOf(nodes, 'a')).toBe(escaped);
    expect(pausesText(nodes, 'other', [{ id: 'a', by: 'agent:a' }])).toBe(
      `${escaped} on its group "${escaped}"`,
    );
  });

  it('caps the name before escaping it, without cutting an escape sequence', () => {
    const nodes = [{ id: 'a', data: { label: `${'x'.repeat(119)}"injected` } }];
    expect(quotedParty(nodes, 'agent:a')).toBe(`"${'x'.repeat(119)}\\"…"`);
    expect(nameOf(nodes, 'a')).toBe(`${'x'.repeat(119)}\\"…`);
  });

  it('keeps display names as display text and the user’s fixed name as prose', () => {
    expect(partyName(nodes, 'agent:a')).toContain('Worker"\\');
    expect(quotedParty(nodes, 'you')).toBe('the user');
    expect(quotedParty(nodes, 'outside:builder')).toBe('"builder"');
  });
});
