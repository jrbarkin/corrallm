import { describe, expect, it } from 'vitest';

import { formContent, formFields, mcpServer } from './mcp';

describe('mcpServer', () => {
  it('says how a server is, as /mcp shows it', () => {
    expect(
      mcpServer({
        name: 'github',
        status: 'connected',
        serverInfo: { name: 'github-mcp', version: '1.2.0' },
        scope: 'user',
        tools: [{ name: 'create_issue' }, { name: 'list_prs' }],
      }),
    ).toEqual({
      name: 'github',
      status: 'connected',
      server: 'github-mcp 1.2.0',
      scope: 'user',
      tools: 2,
    });
    expect(
      mcpServer({
        name: 'sentry',
        status: 'failed',
        error: 'Connection refused',
        scope: 'project',
      }),
    ).toEqual({ name: 'sentry', status: 'failed', error: 'Connection refused', scope: 'project' });
  });
});

/** A form as an MCP server asks for it, every kind of field. */
const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', title: 'Issue title', minLength: 3, maxLength: 80 },
    email: { type: 'string', format: 'email', description: 'Where replies go' },
    count: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
    ratio: { type: 'number' },
    urgent: { type: 'boolean', title: 'Urgent?', default: false },
    priority: { type: 'string', enum: ['p1', 'p2'], enumNames: ['High', 'Low'] },
    team: { type: 'string', oneOf: [{ const: 'web', title: 'Web team' }, { const: 'api' }] },
    labels: { type: 'array', items: { type: 'string', enum: ['bug', 'ui'] }, maxItems: 2 },
    areas: { type: 'array', items: { anyOf: [{ const: 'db', title: 'Database' }] } },
  },
  required: ['title', 'priority'],
};

describe('formFields', () => {
  it('reads the fields of a form an MCP server asks for', () => {
    expect(formFields(SCHEMA)).toEqual([
      { name: 'title', label: 'Issue title', required: true, kind: 'text', min: 3, max: 80 },
      {
        name: 'email',
        label: 'email',
        description: 'Where replies go',
        required: false,
        kind: 'text',
        format: 'email',
      },
      {
        name: 'count',
        label: 'count',
        required: false,
        kind: 'integer',
        min: 1,
        max: 5,
        default: 1,
      },
      { name: 'ratio', label: 'ratio', required: false, kind: 'number' },
      { name: 'urgent', label: 'Urgent?', required: false, kind: 'boolean', default: false },
      {
        name: 'priority',
        label: 'priority',
        required: true,
        kind: 'choice',
        options: [
          { value: 'p1', label: 'High' },
          { value: 'p2', label: 'Low' },
        ],
      },
      {
        name: 'team',
        label: 'team',
        required: false,
        kind: 'choice',
        options: [
          { value: 'web', label: 'Web team' },
          { value: 'api', label: 'api' },
        ],
      },
      {
        name: 'labels',
        label: 'labels',
        required: false,
        kind: 'choices',
        options: [
          { value: 'bug', label: 'bug' },
          { value: 'ui', label: 'ui' },
        ],
        max: 2,
      },
      {
        name: 'areas',
        label: 'areas',
        required: false,
        kind: 'choices',
        options: [{ value: 'db', label: 'Database' }],
      },
    ]);
  });

  it('cannot show what is not a flat form of those fields', () => {
    expect(formFields(undefined)).toEqual([]);
    expect(formFields({ type: 'object', properties: {} })).toEqual([]);
    expect(formFields({ type: 'array' })).toBeUndefined();
    expect(
      formFields({ type: 'object', properties: { nested: { type: 'object' } } }),
    ).toBeUndefined();
    expect(formFields({ type: 'object', properties: { list: { type: 'array' } } })).toBeUndefined();
  });
});

describe('formContent', () => {
  const fields = formFields(SCHEMA) ?? [];

  it('answers with the values given, those left empty and optional left out', () => {
    expect(
      formContent(fields, {
        title: 'Login fails',
        email: '',
        count: 2,
        urgent: true,
        priority: 'p1',
        labels: ['bug'],
      }),
    ).toEqual({ title: 'Login fails', count: 2, urgent: true, priority: 'p1', labels: ['bug'] });
  });

  it.each([
    ['a required field missing', { priority: 'p1' }, /Issue title is required/],
    ['text too short', { title: 'No', priority: 'p1' }, /at least 3/],
    ['an address that is not one', { title: 'Bug', priority: 'p1', email: 'me' }, /email address/],
    ['a number out of bounds', { title: 'Bug', priority: 'p1', count: 9 }, /at most 5/],
    ['a fraction for a whole number', { title: 'Bug', priority: 'p1', count: 1.5 }, /whole/],
    ['a choice not offered', { title: 'Bug', priority: 'p9' }, /one of/],
    [
      'too many choices',
      { title: 'Bug', priority: 'p1', labels: ['bug', 'ui', 'ui'] },
      /at most 2/,
    ],
    ['a value of the wrong kind', { title: 'Bug', priority: 'p1', urgent: 'yes' }, /yes or no/],
    ['a field it did not ask for', { title: 'Bug', priority: 'p1', extra: 'x' }, /extra/],
  ])('refuses %s', (_label, values, message) => {
    expect(() => formContent(fields, values)).toThrow(message);
  });
});
