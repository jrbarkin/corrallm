import { describe, expect, it } from 'vitest';

import { ArgumentError, OPERATIONS, operationsFor } from './operations';

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('the operations', () => {
  it('are listed to each scope as it may use them, wait to none', () => {
    const listed = (scope: 'agent' | 'lead' | 'outside') =>
      operationsFor(scope)
        .filter((operation) => operation.listed)
        .map((operation) => operation.name);
    expect(listed('agent')).toEqual(['message', 'reply']);
    expect(listed('lead')).toEqual(['message', 'reply', 'status']);
    expect(listed('outside')).toEqual(['message', 'reply', 'status']);
    // Only an orchestrator outside corrallm may wait, and only from the command line.
    expect(operationsFor('outside').map((operation) => operation.name)).toContain('wait');
    expect(operationsFor('agent').map((operation) => operation.name)).not.toContain('wait');
  });

  it('read what a client sent', () => {
    expect(OPERATIONS.message.parse({ to: 'codex', body: 'Make the tests pass' })).toEqual({
      to: 'codex',
      body: 'Make the tests pass',
    });
    expect(OPERATIONS.reply.parse({ to: ID, choices: ['approve'] })).toEqual({
      to: ID,
      choices: ['approve'],
    });
    expect(OPERATIONS.wait.parse({ for: ID })).toEqual({ for: ID, timeoutSeconds: 600 });
    expect(OPERATIONS.status.parse(undefined)).toEqual({});
  });

  it.each([
    ['message', { to: 'codex' }],
    ['message', { to: '../etc', body: 'hi' }],
    ['message', { to: 'codex', body: 'hi', replyTo: '--resume' }],
    ['message', { to: 'codex', body: 'hi', extra: true }],
    ['reply', { to: ID }],
    ['reply', { to: ID, choices: [] }],
    ['reply', { to: 'not-an-id', text: 'yes' }],
    ['wait', { timeoutSeconds: 0 }],
    ['wait', { timeoutSeconds: 86_400 }],
    ['status', { anything: 1 }],
    ['message', 'just text'],
  ] as const)('refuse %s with %j, saying why', (operation, args) => {
    expect(() => OPERATIONS[operation].parse(args)).toThrow(ArgumentError);
  });
});
