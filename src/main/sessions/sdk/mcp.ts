import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

import { MAX_FORM_FIELDS } from '../../../shared/session';
import type { FormField, FormValue, McpServer } from '../../../shared/session';
import { property, text } from './tools';

/*
 * What corrallm shows of a session's MCP servers: how each is (/mcp), and the forms a server asks
 * the user to fill in (MCP elicitations, in the flat JSON Schema subset the protocol allows: text,
 * numbers, yes or no, one or several choices). A form's answer is checked against the form before
 * it goes back to the server.
 */

/** A server, as /mcp lists it. */
export function mcpServer(status: McpServerStatus): McpServer {
  const info = status.serverInfo;
  return {
    name: status.name,
    status: status.status,
    ...(status.scope === undefined || status.scope === '' ? {} : { scope: status.scope }),
    ...(info === undefined ? {} : { server: `${info.name} ${info.version}`.trim() }),
    ...(status.status === 'connected' && status.tools !== undefined
      ? { tools: status.tools.length }
      : {}),
    ...(status.error === undefined || status.error === '' ? {} : { error: status.error }),
  };
}

const FORMATS = ['email', 'uri', 'date', 'date-time'] as const;

/**
 * The fields of the form a server asks for (its requestedSchema): none if it asks for nothing,
 * undefined if it is not a form corrallm can show.
 */
export function formFields(schema: unknown): FormField[] | undefined {
  if (schema === undefined || schema === null) return [];
  if (property(schema, 'type') !== 'object') return undefined;
  const properties: unknown = property(schema, 'properties') ?? {};
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const required = property(schema, 'required');
  const needed = new Set(
    Array.isArray(required) ? required.filter((r) => typeof r === 'string') : [],
  );
  const entries = Object.entries(properties);
  if (entries.length > MAX_FORM_FIELDS) return undefined;
  const fields = entries.map(([name, spec]) => field(name, spec, needed.has(name)));
  return fields.every((f) => f !== undefined) ? fields : undefined;
}

function field(name: string, spec: unknown, required: boolean): FormField | undefined {
  const kind = property(spec, 'type');
  const title = text(property(spec, 'title'))?.trim();
  const label = title === undefined || title === '' ? name : title;
  const description = text(property(spec, 'description'))?.trim();
  const base = {
    name,
    label,
    ...(description === undefined || description === '' ? {} : { description }),
    required,
  };
  const number = (key: string) => {
    const value = property(spec, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const bounds = (min: string, max: string) => {
    const [low, high] = [number(min), number(max)];
    return {
      ...(low === undefined ? {} : { min: low }),
      ...(high === undefined ? {} : { max: high }),
    };
  };
  const fallback = property(spec, 'default');
  switch (kind) {
    case 'string': {
      const options = choicesOf(spec);
      if (options !== undefined) {
        return {
          ...base,
          kind: 'choice',
          options,
          ...(typeof fallback === 'string' ? { default: fallback } : {}),
        };
      }
      const format = FORMATS.find((f) => f === property(spec, 'format'));
      return {
        ...base,
        kind: 'text',
        ...(format === undefined ? {} : { format }),
        ...bounds('minLength', 'maxLength'),
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
      };
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind,
        ...bounds('minimum', 'maximum'),
        ...(typeof fallback === 'number' ? { default: fallback } : {}),
      };
    case 'boolean':
      return {
        ...base,
        kind: 'boolean',
        ...(typeof fallback === 'boolean' ? { default: fallback } : {}),
      };
    case 'array': {
      const options = choicesOf(property(spec, 'items'));
      if (options === undefined) return undefined;
      const chosen = Array.isArray(fallback) ? fallback.filter((f) => typeof f === 'string') : [];
      return {
        ...base,
        kind: 'choices',
        options,
        ...bounds('minItems', 'maxItems'),
        ...(chosen.length > 0 ? { default: chosen } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** A choice's options: `enum` (named by `enumNames`), or `oneOf`/`anyOf` of `const` and `title`. */
function choicesOf(spec: unknown): { value: string; label: string }[] | undefined {
  const listed = property(spec, 'enum');
  if (Array.isArray(listed)) {
    const names = property(spec, 'enumNames');
    const values = listed.filter((v): v is string => typeof v === 'string');
    if (values.length !== listed.length || values.length > MAX_FORM_FIELDS) return undefined;
    return values.map((value, i) => ({
      value,
      label: (Array.isArray(names) ? text(names[i]) : undefined) ?? value,
    }));
  }
  const titled = property(spec, 'oneOf') ?? property(spec, 'anyOf');
  if (!Array.isArray(titled) || titled.length > MAX_FORM_FIELDS) return undefined;
  const options = titled.map((option) => {
    const value = text(property(option, 'const'));
    return value === undefined
      ? undefined
      : { value, label: text(property(option, 'title')) ?? value };
  });
  return options.every((o) => o !== undefined) ? options : undefined;
}

/**
 * The content to answer a form with: the values given, checked against its fields (one left empty
 * and optional is left out). Throws, saying what is wrong, if one is not what the form asks for.
 */
export function formContent(
  fields: readonly FormField[],
  values: Readonly<Record<string, FormValue>>,
): Record<string, FormValue> {
  for (const name of Object.keys(values)) {
    if (!fields.some((f) => f.name === name)) throw new Error(`The form has no field ${name}.`);
  }
  const content: [string, FormValue][] = [];
  for (const f of fields) {
    const value = Object.hasOwn(values, f.name) ? values[f.name] : undefined;
    const empty =
      value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (f.required) throw new Error(`${f.label} is required.`);
      continue;
    }
    content.push([f.name, checked(f, value)]);
  }
  return Object.fromEntries(content);
}

/** `value` if it is what field `f` takes; throws saying why not. */
function checked(f: FormField, value: FormValue): FormValue {
  const { label, min, max } = f;
  const within = (count: number, what: (n: number) => string) => {
    if (min !== undefined && count < min)
      throw new Error(`${label} must be at least ${what(min)}.`);
    if (max !== undefined && count > max) throw new Error(`${label} must be at most ${what(max)}.`);
  };
  const offered = (choice: string) => {
    if (!(f.options ?? []).some((o) => o.value === choice)) {
      throw new Error(
        `${label} must be one of: ${(f.options ?? []).map((o) => o.label).join(', ')}.`,
      );
    }
  };
  switch (f.kind) {
    case 'text': {
      if (typeof value !== 'string') throw new Error(`${label} must be text.`);
      within(value.length, (n) => `${String(n)} characters`);
      if (f.format !== undefined && !FORMAT_CHECKS[f.format](value)) {
        throw new Error(`${label} must be ${FORMAT_WORDS[f.format]}.`);
      }
      return value;
    }
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a number.`);
      }
      if (f.kind === 'integer' && !Number.isInteger(value)) {
        throw new Error(`${label} must be a whole number.`);
      }
      within(value, String);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${label} must be yes or no.`);
      return value;
    case 'choice':
      if (typeof value !== 'string') throw new Error(`${label} must be one choice.`);
      offered(value);
      return value;
    case 'choices':
      if (!Array.isArray(value)) throw new Error(`${label} must be a list of choices.`);
      value.forEach(offered);
      within(value.length, (n) => `${String(n)} choice${n === 1 ? '' : 's'}`);
      return [...value];
  }
}

const FORMAT_CHECKS: Record<(typeof FORMATS)[number], (value: string) => boolean> = {
  email: (value) => /^[^\s@]+@[^\s@]+$/.test(value),
  uri: (value) => URL.canParse(value),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
  'date-time': (value) => !Number.isNaN(Date.parse(value)),
};

const FORMAT_WORDS: Record<(typeof FORMATS)[number], string> = {
  email: 'an email address',
  uri: 'a URL',
  date: 'a date (2026-10-12)',
  'date-time': 'a date and time (2026-10-12T14:30:00Z)',
};
