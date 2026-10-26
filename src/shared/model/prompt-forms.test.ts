import { describe, expect, it } from 'vitest';

import {
  AdapterPrompt,
  FlatFormSchema,
  checkPromptAnswer,
  formContent,
  formFields,
  parseForm,
} from './prompts';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string', title: 'Issue title', minLength: 3, maxLength: 80, pattern: '[' },
    email: { type: 'string', format: 'email' },
    count: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
    ratio: { type: 'number' },
    urgent: { type: 'boolean', default: false },
    priority: { type: 'string', enum: ['p1', 'p2'], enumNames: ['High', 'Low'] },
    team: { type: 'string', oneOf: [{ const: 'web', title: 'Web team' }, { const: 'api' }] },
    labels: {
      type: 'array',
      items: { type: 'string', enum: ['bug', 'ui'] },
      minItems: 1,
      maxItems: 2,
    },
    areas: {
      type: 'array',
      items: { anyOf: [{ const: 'db', title: 'Database' }] },
      default: ['db'],
    },
  },
  required: ['title', 'priority'],
};

describe('the shared flat-form parser and normalized schema', () => {
  it('lifts every supported field kind, serializes the parsed meaning and drops pattern without executing it', () => {
    const parsed = parseForm(schema);
    expect(parsed).toBeDefined();
    if (!parsed) return;
    expect(parsed.fields.map(({ kind }) => kind)).toEqual([
      'text',
      'text',
      'integer',
      'number',
      'boolean',
      'choice',
      'choice',
      'choices',
      'choices',
    ]);
    expect(parsed.schema).not.toBe(schema);
    expect(parsed.schema.properties.title).not.toHaveProperty('pattern');
    expect(parsed.schema.properties.team).toEqual({
      type: 'string',
      title: 'team',
      enum: ['web', 'api'],
      enumNames: ['Web team', 'api'],
    });
    expect(parsed.schema.required).toEqual(['title', 'priority']);
    expect(parsed.schema.additionalProperties).toBe(false);
    expect(FlatFormSchema.safeParse(parsed.schema).success).toBe(true);
    expect(parseForm(parsed.schema)).toEqual(parsed);
    expect(formFields(schema)).toEqual(parsed.fields);
    expect(schema.properties.title.pattern).toBe('[');
  });

  it('keeps empty forms and handles all 50 fields and options without truncation', () => {
    for (const empty of [undefined, null, {}, { type: 'object' }])
      expect(parseForm(empty)?.fields).toEqual([]);
    const options = Array.from({ length: 50 }, (_, i) => String(i));
    const properties = Object.fromEntries(
      options.map((key) => [key, { type: 'string', enum: options }]),
    );
    expect(parseForm({ type: 'object', properties })?.fields).toHaveLength(50);
    expect(
      parseForm({ type: 'object', properties: { ...properties, extra: { type: 'string' } } }),
    ).toBeUndefined();
    expect(
      parseForm({
        type: 'object',
        properties: { choice: { type: 'string', enum: [...options, 'extra'] } },
      }),
    ).toBeUndefined();
  });

  it('preserves a primitive field whose name looks like a prototype property', () => {
    const properties = Object.fromEntries([['__proto__', { type: 'boolean' }]]);
    const parsed = parseForm({ type: 'object', properties, required: ['__proto__'] });
    expect(parsed?.fields.map(({ name }) => name)).toEqual(['__proto__']);
    expect(formContent(parsed?.fields ?? [], Object.fromEntries([['__proto__', true]]))).toEqual(
      Object.fromEntries([['__proto__', true]]),
    );
  });

  it.each([
    { $ref: '#/something' },
    { type: 'array' },
    { type: 'object', allOf: [] },
    { type: 'object', required: ['absent'] },
    { type: 'object', required: [1] },
    { type: 'object', properties: { nested: { type: 'object' } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['a', 1] } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['a', 'a'] } } },
    { type: 'object', properties: { x: { type: 'string', enum: [] } } },
    { type: 'object', properties: { x: { type: 'string', oneOf: [{ const: 1 }] } } },
    { type: 'object', properties: { x: { type: 'string', minLength: 5, maxLength: 1 } } },
    { type: 'object', properties: { x: { type: 'string', minLength: 1.5 } } },
    { type: 'object', properties: { x: { type: 'string', $ref: 'file:///private' } } },
    { type: 'object', properties: { x: { type: 'array', items: { type: 'object' } } } },
    { type: 'object', properties: { x: { type: 'integer', default: 1.5 } } },
    { type: 'object', properties: { x: { type: 'boolean', default: 'false' } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['a'], default: 'b' } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['a'], oneOf: [{ const: 'b' }] } } },
  ])('refuses unsupported or ambiguous structure whole: %j', (invalid) => {
    expect(parseForm(invalid)).toBeUndefined();
  });
});

describe('form value checking', () => {
  const fields = formFields(schema) ?? [];
  it('uses values rather than labels, checks bounds, leaves optional blanks out and never applies defaults as answers', () => {
    expect(
      formContent(fields, {
        title: 'Login fails',
        priority: 'p1',
        email: '',
        count: 2,
        urgent: false,
        labels: ['bug'],
      }),
    ).toEqual({ title: 'Login fails', priority: 'p1', count: 2, urgent: false, labels: ['bug'] });
    expect(formContent(fields, { title: 'Login fails', priority: 'p2' })).not.toHaveProperty(
      'count',
    );
    for (const values of [
      { priority: 'p1' },
      { title: 'No', priority: 'p1' },
      { title: 'Issue', priority: 'High' },
      { title: 'Issue', priority: 'p1', extra: 'x' },
      { title: 'Issue', priority: 'p1', count: 1.5 },
      { title: 'Issue', priority: 'p1', count: 6 },
      { title: 'Issue', priority: 'p1', urgent: 'yes' },
      { title: 'Issue', priority: 'p1', labels: ['bug', 'bug'] },
      { title: 'Issue', priority: 'p1', labels: ['unknown'] },
      { title: 'Issue', priority: 'p1', ratio: Number.POSITIVE_INFINITY },
      { title: 'Issue', priority: 'p1', email: 'me' },
    ])
      expect(() => formContent(fields, values)).toThrow();
  });

  it('checks formats without running server patterns or custom formats', () => {
    const fields =
      formFields({
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date' },
          timestamp: { type: 'string', format: 'date-time' },
          uri: { type: 'string', format: 'uri' },
          ignored: { type: 'string', format: 'custom', pattern: '(a+)+$' },
        },
      }) ?? [];
    expect(
      formContent(fields, {
        date: '2026-10-26',
        timestamp: '2026-10-26T12:30:00Z',
        uri: 'https://example.test',
        ignored: 'anything',
      }),
    ).toHaveProperty('ignored', 'anything');
    for (const values of [
      { date: '2026-02-30' },
      { date: 'yesterday' },
      { timestamp: '2026-10-26' },
      { timestamp: '2026-10-26T24:00:00Z' },
      { uri: 'not a URL' },
    ])
      expect(() => formContent(fields, values)).toThrow();
  });

  it('checks explicit required values by their schema, including an offered empty-string choice and an empty selection', () => {
    const fields =
      formFields({
        type: 'object',
        properties: {
          choice: { type: 'string', enum: ['', 'x'] },
          selection: { type: 'array', items: { type: 'string', enum: ['x'] }, minItems: 0 },
          text: { type: 'string', minLength: 0 },
        },
        required: ['choice', 'selection', 'text'],
      }) ?? [];
    expect(formContent(fields, { choice: '', selection: [], text: '' })).toEqual({
      choice: '',
      selection: [],
      text: '',
    });
    expect(() => formContent(fields, { choice: '', selection: [] })).toThrow(/required/);
  });

  it('retains explicit empty choice values and selections instead of replacing them with absence', () => {
    const fields =
      formFields({
        type: 'object',
        properties: {
          choice: { type: 'string', enum: ['', 'x'], default: 'x' },
          selection: { type: 'array', items: { type: 'string', enum: ['x'] }, default: ['x'] },
        },
      }) ?? [];
    expect(formContent(fields, { choice: '', selection: [] })).toEqual({
      choice: '',
      selection: [],
    });
  });

  it('allows values only for an accepted schema form; a URL form carries no fabricated values', () => {
    const parsed = parseForm(schema);
    if (!parsed) throw new Error('The fixture is a form.');
    const prompt = AdapterPrompt.parse({
      kind: 'form',
      title: 'Issue',
      form: { schema: parsed.schema },
      answerIn: 'api',
    });
    expect(
      checkPromptAnswer(prompt, {
        kind: 'form',
        action: 'accept',
        values: { title: 'Issue', priority: 'p1' },
      }),
    ).toMatchObject({ values: { title: 'Issue', priority: 'p1' } });
    expect(() => checkPromptAnswer(prompt, { kind: 'form', action: 'accept' })).toThrow();
    for (const action of ['cancel', 'decline']) {
      expect(checkPromptAnswer(prompt, { kind: 'form', action })).toEqual({ kind: 'form', action });
      expect(() => checkPromptAnswer(prompt, { kind: 'form', action, values: {} })).toThrow();
    }
    const url = AdapterPrompt.parse({
      kind: 'form',
      title: 'Sign in',
      form: { url: 'https://example.test/login' },
      answerIn: 'api',
    });
    expect(checkPromptAnswer(url, { kind: 'form', action: 'accept' })).toEqual({
      kind: 'form',
      action: 'accept',
    });
    expect(() => checkPromptAnswer(url, { kind: 'form', action: 'accept', values: {} })).toThrow();
  });
});
