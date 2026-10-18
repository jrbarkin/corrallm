import type { z } from 'zod';

import { defOf, ID_BRANDS } from './ids';
import type { Brand } from './ids';

/*
 * What the registry's tests read from an op's zod schemas: the schemas inside one, and the kinds
 * of id it takes anywhere (T1's checks in surface.test.ts, T3b's reach in core/callers.test.ts).
 */

/** The schemas directly inside `schema`, each with the argument name it is under, if any. */
export function children(schema: z.ZodType): { key?: string; schema: z.ZodType }[] {
  const def = defOf(schema);
  const all = (list: (z.ZodType | null | undefined)[]) =>
    list.flatMap((child) => (child ? [{ schema: child }] : []));
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape ?? {}).map(([key, child]) => ({ key, schema: child }));
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return all([def.innerType]);
    case 'array':
      return all([def.element]);
    case 'tuple':
      return all([...(def.items ?? []), def.rest]);
    case 'record':
      return all([def.keyType, def.valueType]);
    case 'union':
      return all(def.options ?? []);
    case 'intersection':
      return all([def.left, def.right]);
    case 'pipe':
      return all([def.in]);
    case 'lazy':
      return all([def.getter?.()]);
    default:
      return [];
  }
}

/** Every kind of id named anywhere in `schema`. */
export function brandsIn(schema: z.ZodType): Brand[] {
  const brand = ID_BRANDS.get(schema)?.brand;
  return brand ? [brand] : children(schema).flatMap((child) => brandsIn(child.schema));
}
