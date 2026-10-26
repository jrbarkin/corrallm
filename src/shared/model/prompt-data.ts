import { z } from 'zod';

import { MAX_ID_LENGTH } from '../api/limits';

export type PromptJson =
  null | boolean | number | string | PromptJson[] | { [key: string]: PromptJson };

export function promptJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
}

/** A bounded data record that retains every key, including __proto__, without assigning it. */
export function promptRecord<V extends z.ZodType>(value: V, max: number) {
  const key = z.string().min(1).max(MAX_ID_LENGTH);
  const wire = z.record(key, value);
  return z
    .unknown()
    .refine(
      (input): input is Record<string, z.output<V>> => {
        if (
          !plainRecord(input) ||
          Object.keys(input).length > max ||
          Object.getOwnPropertySymbols(input).length > 0
        )
          return false;
        for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
          if (
            !descriptor.enumerable ||
            !('value' in descriptor) ||
            !key.safeParse(name).success ||
            !value.safeParse(descriptor.value).success
          )
            return false;
        }
        return true;
      },
      { message: 'A bounded record of valid data is required.', abort: true },
    )
    .overwrite((input) =>
      Object.fromEntries(Object.entries(input).map(([name, raw]) => [name, value.parse(raw)])),
    )
    .meta({ ...z.toJSONSchema(wire), maxProperties: max });
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Measure JSON incrementally, refusing depth/cycles/accessors before serializing nested data. */
export function boundedPromptJson(
  value: unknown,
  maxBytes: number,
  maxDepth: number,
): value is PromptJson {
  const active = new Set<object>();
  let bytes = 0;
  const add = (size: number) => (bytes += size) <= maxBytes;
  const visit = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value === 'boolean')
      return add(value === null ? 4 : value ? 4 : 5);
    if (typeof value === 'number') return Number.isFinite(value) && add(promptJsonBytes(value));
    if (typeof value === 'string') return value.length <= maxBytes && add(promptJsonBytes(value));
    if (
      typeof value !== 'object' ||
      depth >= maxDepth ||
      active.has(value) ||
      Object.getOwnPropertySymbols(value).length > 0
    )
      return false;
    if (!Array.isArray(value) && !plainRecord(value)) return false;
    active.add(value);
    if (Array.isArray(value)) {
      if (value.length > maxBytes || !add(2 + Math.max(0, value.length - 1))) return false;
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (!descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1))
          return false;
      }
      if (Object.keys(value).length !== value.length) return false;
    } else {
      const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
      if (!add(2 + Math.max(0, entries.length - 1))) return false;
      for (const [key, descriptor] of entries) {
        if (
          !descriptor.enumerable ||
          !('value' in descriptor) ||
          key.length > maxBytes ||
          !add(promptJsonBytes(key) + 1) ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
    }
    active.delete(value);
    return true;
  };
  return visit(value, 0);
}
