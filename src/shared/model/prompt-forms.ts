import { z } from 'zod';

import {
  MAX_ANSWER_LENGTH,
  MAX_FORM_FIELDS,
  MAX_ID_LENGTH,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_LABEL_LENGTH,
  MAX_PROMPT_TEXT_LENGTH,
} from '../api/limits';
import type { FormField, FormValue } from '../session';
import { promptRecord } from './prompt-data';

const FieldName = z.string().min(1).max(MAX_ID_LENGTH);
const Label = z.string().min(1).max(MAX_PROMPT_LABEL_LENGTH);
const Value = z.string().max(MAX_ANSWER_LENGTH);
const Count = z.int().min(0);
const Formats = z.enum(['email', 'uri', 'date', 'date-time']);
const common = { title: Label, description: z.string().max(MAX_PROMPT_TEXT_LENGTH).optional() };
const options = {
  enum: z.array(Value).min(1).max(MAX_FORM_FIELDS),
  enumNames: z.array(z.string().max(MAX_PROMPT_LABEL_LENGTH)).min(1).max(MAX_FORM_FIELDS),
};
const ChoiceItems = z.strictObject({ type: z.literal('string'), ...options });
const Property = z.union([
  z.strictObject({
    ...common,
    type: z.literal('string'),
    minLength: Count.optional(),
    maxLength: Count.optional(),
    format: Formats.optional(),
    default: Value.optional(),
  }),
  z.strictObject({ ...common, type: z.literal('string'), ...options, default: Value.optional() }),
  z.strictObject({
    ...common,
    type: z.enum(['number', 'integer']),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.strictObject({ ...common, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({
    ...common,
    type: z.literal('array'),
    items: ChoiceItems,
    minItems: Count.optional(),
    maxItems: Count.optional(),
    default: z.array(Value).max(MAX_FORM_FIELDS).optional(),
  }),
]);

/** The schema the card and checker share: only the parsed flat subset, re-serialized. */
export const FlatFormSchema = z
  .strictObject({
    type: z.literal('object'),
    properties: promptRecord(Property, MAX_FORM_FIELDS),
    required: z.array(FieldName).max(MAX_FORM_FIELDS),
    additionalProperties: z.literal(false),
  })
  .refine((schema) => {
    if (
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some((name) => !Object.hasOwn(schema.properties, name))
    )
      return false;
    return Object.values(schema.properties).every((property) => {
      if ('enum' in property && !validOptions(property.enum, property.enumNames)) return false;
      if (property.type === 'array' && !validOptions(property.items.enum, property.items.enumNames))
        return false;
      const field = normalizedField('', property, false);
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) return false;
      if (field.kind === 'text' && (field.min ?? 0) > MAX_ANSWER_LENGTH) return false;
      if (field.kind === 'choices' && (field.min ?? 0) > (field.options?.length ?? 0)) return false;
      if (field.default !== undefined) {
        try {
          checked(field, field.default);
        } catch {
          return false;
        }
      }
      return true;
    });
  }, 'A complete, consistent flat form')
  .refine((schema) => jsonBytes(schema) <= MAX_PROMPT_BYTES, 'The form fits the prompt budget');
export type FlatFormSchema = z.infer<typeof FlatFormSchema>;
type Property = z.infer<typeof Property>;

export interface ParsedForm {
  schema: FlatFormSchema;
  fields: FormField[];
}

/**
 * Lifted from the SDK form reader. Parse only MCP's flat primitive subset, then serialize what
 * was parsed. Patterns and annotations are never evaluated. Structural schema languages are
 * refused, not partly interpreted. Native adapters migrate to this helper in their own tasks.
 */
export function parseForm(value: unknown): ParsedForm | undefined {
  value ??= {};
  if (!record(value)) return undefined;
  const empty = Object.keys(value).length === 0;
  if ((!empty && value.type !== 'object') || unsupported(value, 'root')) return undefined;
  const properties: unknown = value.properties ?? {};
  if (!record(properties)) return undefined;
  const required: unknown = value.required ?? [];
  if (
    !Array.isArray(required) ||
    required.length > MAX_FORM_FIELDS ||
    !required.every((name): name is string => FieldName.safeParse(name).success)
  )
    return undefined;
  if (
    new Set(required).size !== required.length ||
    required.some((name) => !Object.hasOwn(properties, name))
  )
    return undefined;
  const entries = Object.entries(properties);
  if (entries.length > MAX_FORM_FIELDS) return undefined;
  const parsed: [string, Property][] = [];
  for (const [name, raw] of entries) {
    if (!FieldName.safeParse(name).success) return undefined;
    const property = parseProperty(name, raw);
    if (property === undefined) return undefined;
    parsed.push([name, property]);
  }
  const result = FlatFormSchema.safeParse({
    type: 'object',
    properties: Object.fromEntries(parsed),
    required: entries.map(([name]) => name).filter((name) => required.includes(name)),
    additionalProperties: false,
  });
  if (!result.success) return undefined;
  const schema = result.data;
  return {
    schema,
    fields: Object.entries(schema.properties).map(([name, property]) =>
      normalizedField(name, property, schema.required.includes(name)),
    ),
  };
}

/** Compatibility-shaped view for consumers of the lifted reader. No schema is retained here. */
export function formFields(schema: unknown): FormField[] | undefined {
  return parseForm(schema)?.fields;
}

const structural = new Set([
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$defs',
  'definitions',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependencies',
  'dependentSchemas',
  'dependentRequired',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'additionalItems',
  'contains',
  'const',
]);
function unsupported(
  schema: Record<string, unknown>,
  where: 'root' | 'property' | 'items' | 'option',
): boolean {
  if (
    Object.keys(schema).some(
      (key) => structural.has(key) && !(key === 'const' && where === 'option'),
    )
  )
    return true;
  if (Object.hasOwn(schema, 'additionalProperties') && schema.additionalProperties !== false)
    return true;
  if (
    where === 'root' &&
    ['enum', 'oneOf', 'anyOf', 'items'].some((key) => Object.hasOwn(schema, key))
  )
    return true;
  if (where !== 'root' && ['properties', 'required'].some((key) => Object.hasOwn(schema, key)))
    return true;
  return false;
}

function parseProperty(name: string, raw: unknown): Property | undefined {
  if (!record(raw) || unsupported(raw, 'property')) return undefined;
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : name;
  const description =
    typeof raw.description === 'string' && raw.description.trim() !== ''
      ? raw.description.trim()
      : undefined;
  const base = { title, ...(description === undefined ? {} : { description }) };
  const fallback = Object.hasOwn(raw, 'default') ? { default: raw.default } : {};
  const bounds = (min: string, max: string) => ({
    ...(Object.hasOwn(raw, min) ? { [min]: raw[min] } : {}),
    ...(Object.hasOwn(raw, max) ? { [max]: raw[max] } : {}),
  });
  let result: unknown;
  switch (raw.type) {
    case 'string': {
      if (Object.hasOwn(raw, 'items') || Object.hasOwn(raw, 'anyOf')) return undefined;
      const hasChoices = ['enum', 'oneOf', 'enumNames'].some((key) => Object.hasOwn(raw, key));
      if (hasChoices) {
        const chosen = parseOptions(raw, 'oneOf');
        if (!chosen || ['minLength', 'maxLength', 'format'].some((key) => Object.hasOwn(raw, key)))
          return undefined;
        result = { ...base, type: 'string', ...chosen, ...fallback };
      } else {
        const format = Formats.safeParse(raw.format);
        result = {
          ...base,
          type: 'string',
          ...bounds('minLength', 'maxLength'),
          ...(format.success ? { format: format.data } : {}),
          ...fallback,
        };
      }
      break;
    }
    case 'number':
    case 'integer':
      if (['enum', 'oneOf', 'anyOf', 'items'].some((key) => Object.hasOwn(raw, key)))
        return undefined;
      result = { ...base, type: raw.type, ...bounds('minimum', 'maximum'), ...fallback };
      break;
    case 'boolean':
      if (['enum', 'oneOf', 'anyOf', 'items'].some((key) => Object.hasOwn(raw, key)))
        return undefined;
      result = { ...base, type: 'boolean', ...fallback };
      break;
    case 'array': {
      if (
        ['enum', 'oneOf', 'anyOf'].some((key) => Object.hasOwn(raw, key)) ||
        !record(raw.items) ||
        unsupported(raw.items, 'items') ||
        (raw.items.type !== undefined && raw.items.type !== 'string')
      )
        return undefined;
      const chosen = parseOptions(raw.items, 'anyOf');
      if (!chosen) return undefined;
      result = {
        ...base,
        type: 'array',
        items: { type: 'string', ...chosen },
        ...bounds('minItems', 'maxItems'),
        ...fallback,
      };
      break;
    }
    default:
      return undefined;
  }
  const property = Property.safeParse(result);
  return property.success ? property.data : undefined;
}

function parseOptions(
  raw: Record<string, unknown>,
  combinator: 'oneOf' | 'anyOf',
): z.infer<typeof ChoiceItems> | Omit<z.infer<typeof ChoiceItems>, 'type'> | undefined {
  if (Object.hasOwn(raw, combinator === 'oneOf' ? 'anyOf' : 'oneOf')) return undefined;
  let values: unknown[], labels: unknown[];
  if (Object.hasOwn(raw, 'enum')) {
    if (Object.hasOwn(raw, combinator) || !Array.isArray(raw.enum)) return undefined;
    values = raw.enum;
    if (
      raw.enumNames !== undefined &&
      (!Array.isArray(raw.enumNames) || raw.enumNames.length !== values.length)
    )
      return undefined;
    labels = Array.isArray(raw.enumNames) ? raw.enumNames : values;
  } else {
    const listed = raw[combinator];
    if (!Array.isArray(listed) || raw.enumNames !== undefined) return undefined;
    values = [];
    labels = [];
    for (const option of listed) {
      if (
        !record(option) ||
        unsupported(option, 'option') ||
        Object.keys(option).some((key) => !['const', 'title', 'description'].includes(key))
      )
        return undefined;
      values.push(option.const);
      labels.push(option.title ?? option.const);
    }
  }
  const parsed = z.strictObject(options).safeParse({ enum: values, enumNames: labels });
  return parsed.success && validOptions(parsed.data.enum, parsed.data.enumNames)
    ? parsed.data
    : undefined;
}

function validOptions(values: readonly string[], labels: readonly string[]): boolean {
  return values.length === labels.length && new Set(values).size === values.length;
}

function normalizedField(name: string, property: Property, required: boolean): FormField {
  const base = {
    name,
    label: property.title,
    required,
    ...(property.description === undefined ? {} : { description: property.description }),
    ...('default' in property && property.default !== undefined
      ? { default: property.default }
      : {}),
  };
  const bounds = (min: number | undefined, max: number | undefined) => ({
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  });
  const choices = (values: string[], labels: string[]) =>
    values.map((value, i) => ({ value, label: labels[i] ?? value }));
  switch (property.type) {
    case 'string':
      return 'enum' in property
        ? { ...base, kind: 'choice', options: choices(property.enum, property.enumNames) }
        : {
            ...base,
            kind: 'text',
            ...bounds(property.minLength, property.maxLength),
            ...(property.format === undefined ? {} : { format: property.format }),
          };
    case 'number':
    case 'integer':
      return { ...base, kind: property.type, ...bounds(property.minimum, property.maximum) };
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'array':
      return {
        ...base,
        kind: 'choices',
        options: choices(property.items.enum, property.items.enumNames),
        ...bounds(property.minItems, property.maxItems),
      };
  }
}

/** Values are validated without ever substituting defaults for the person's answer. */
export function formContent(
  fields: readonly FormField[],
  values: Readonly<Record<string, FormValue>>,
): Record<string, FormValue> {
  if (
    !record(values) ||
    fields.length > MAX_FORM_FIELDS ||
    new Set(fields.map((field) => field.name)).size !== fields.length
  )
    throw new Error('Invalid form fields or values.');
  for (const name of Object.keys(values))
    if (!fields.some((field) => field.name === name))
      throw new Error(`The form has no field ${name}.`);
  const content: [string, FormValue][] = [];
  for (const field of fields) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
    if (value === undefined || (!field.required && field.kind === 'text' && value === '')) {
      if (field.required) throw new Error(`${field.label} is required.`);
      continue;
    }
    content.push([field.name, checked(field, value)]);
  }
  return Object.fromEntries(content);
}

function checked(field: FormField, value: FormValue): FormValue {
  const { label, min, max } = field;
  const within = (size: number, what: (value: number) => string) => {
    if (min !== undefined && size < min) throw new Error(`${label} must be at least ${what(min)}.`);
    if (max !== undefined && size > max) throw new Error(`${label} must be at most ${what(max)}.`);
  };
  const offered = (value: string) => {
    if (!(field.options ?? []).some((option) => option.value === value))
      throw new Error(`${label} must be one of the offered values.`);
  };
  switch (field.kind) {
    case 'text':
      if (!Value.safeParse(value).success || typeof value !== 'string')
        throw new Error(`${label} must be text.`);
      within(value.length, (n) => `${String(n)} characters`);
      if (field.format !== undefined && !formatChecks[field.format](value))
        throw new Error(`${label} must be a valid ${field.format}.`);
      return value;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${label} must be a number.`);
      if (field.kind === 'integer' && !Number.isInteger(value))
        throw new Error(`${label} must be a whole number.`);
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
      if (
        !Array.isArray(value) ||
        value.length > MAX_FORM_FIELDS ||
        new Set(value).size !== value.length
      )
        throw new Error(`${label} must be distinct choices.`);
      value.forEach(offered);
      within(value.length, (n) => `${String(n)} choices`);
      return [...value];
  }
}

function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const formatChecks = {
  email: (value: string) => /^[^\s@]+@[^\s@]+$/.test(value),
  uri: (value: string) => URL.canParse(value),
  date,
  'date-time': (value: string) =>
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      value,
    ) &&
    date(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value)),
};
function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
