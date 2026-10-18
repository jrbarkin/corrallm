import { describe, expect, it } from 'vitest';

import { MAX_ROLE_LENGTH } from '../../shared/session';
import { CATALOG } from './adapters';
import { parseStartArgs as parse } from './args';

const parseStartArgs = (args: unknown[]) => parse(args, CATALOG);
const CONNECTIONS = CATALOG.adapters.flatMap((adapter) => adapter.connections.map((c) => c.id));

describe('session role arguments', () => {
  it.each(CONNECTIONS)('accepts a multiline role as data for %s', (connection) => {
    const role =
      'Review releases.\n\tKeep the original formatting.\r\nUse `git diff`, not $(a shell).';
    expect(
      parseStartArgs(['a', { connection, model: null, mode: null, role: `  ${role}  ` }]),
    ).toEqual(['a', { connection, model: null, mode: null, role }]);
  });

  it.each([undefined, '', ' \t\r\n '])(
    'omits a cleared role (%j) from the startup shape',
    (role) => {
      expect(
        parseStartArgs(['a', { connection: 'claude-code.sdk', model: null, mode: null, role }]),
      ).toEqual(['a', { connection: 'claude-code.sdk', model: null, mode: null }]);
    },
  );

  it('accepts the length boundary and rejects longer raw input', () => {
    expect(
      parseStartArgs([
        'a',
        {
          connection: 'claude-code.sdk',
          model: null,
          mode: null,
          role: 'x'.repeat(MAX_ROLE_LENGTH),
        },
      ])[1].role,
    ).toHaveLength(MAX_ROLE_LENGTH);
    expect(() =>
      parseStartArgs([
        'a',
        {
          connection: 'claude-code.sdk',
          model: null,
          mode: null,
          role: 'x'.repeat(MAX_ROLE_LENGTH + 1),
        },
      ]),
    ).toThrow(RangeError);
  });

  it.each([
    null,
    42,
    true,
    [],
    {},
    'unsafe\0role',
    'unsafe\x1brole',
    'unsafe\x7frole',
    'unsafe\u0085role',
  ])('rejects an invalid role (%j)', (role) => {
    expect(() =>
      parseStartArgs(['a', { connection: 'claude-code.sdk', model: null, mode: null, role }]),
    ).toThrow(TypeError);
  });
});
