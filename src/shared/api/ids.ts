import { z } from 'zod';

/*
 * The ids operations name, as zod brands (Core Server §3.1). core.call resolves every branded id in
 * a token's arguments against what its party reaches before the op runs (core/reach.ts): anything
 * out of reach is not-found, so a caller learns nothing about what it can't reach. zod's brand is a
 * type only, so `ID_BRANDS` also keeps each id schema's brand, for the resolver to read at run time.
 * Where a schema hides which id an op gets (a pipe that may change an id once it is checked), the
 * walker fails closed: nothing there is in reach. Each phase brands the ids its operations take.
 */

export type Brand =
  | 'CanvasId'
  | 'AgentId'
  | 'NodeId'
  | 'LinkId'
  | 'ItemId'
  | 'NeedId'
  | 'MessageId'
  | 'ConversationId'
  | 'TaskId'
  | 'TokenId';

/** Each id schema's brand, at run time. */
export const ID_BRANDS = z.registry<{ brand: Brand }>();

/** `schema` as the id `brand`: branded for types, and registered for the reach resolver. */
export function brandedId<B extends Brand, S extends z.ZodString | z.ZodStringFormat>(
  brand: B,
  schema: S,
): z.core.$ZodBranded<S, B> {
  return schema.brand<B>().register(ID_BRANDS, { brand }) as z.core.$ZodBranded<S, B>;
}

/** A Needs item (API Spec §5.9), by the id the core minted: what a proposal returns. */
export const NeedId = brandedId('NeedId', z.uuid());
export type NeedId = z.infer<typeof NeedId>;

/** A branded id found in an op's arguments: its brand, its value, and where it was. */
export interface IdRef {
  brand: Brand;
  id: string;
  path: string;
}

/** The parts of a zod schema's definition that can hold an id. */
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  getter?: () => z.ZodType;
}

/** The definition of a schema, as far as finding ids in it goes. */
export function defOf(schema: z.ZodType): Def {
  return schema._zod.def;
}

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
      return all([def.in, def.out]);
    case 'lazy':
      return all([def.getter?.()]);
    default:
      return [];
  }
}

/** Every kind of id named anywhere in `schema`, on either side of a pipe. */
export function brandsIn(schema: z.ZodType): Brand[] {
  const brand = ID_BRANDS.get(schema)?.brand;
  return brand ? [brand] : children(schema).flatMap((child) => brandsIn(child.schema));
}

/** Thrown where idsIn can't tell which id a parsed value names: core.call answers it not-found. */
export class UnreadableIds extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `There is nothing in reach at ${path.slice(1) || 'the arguments'}: its schema hides which id it names.`,
    );
    this.name = 'UnreadableIds';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every branded id in `value`, which `schema` parsed, with the path to it (`.agent`, `.nodes[0]`).
 * Throws UnreadableIds where the schema hides which id the value names.
 */
export function idsIn(schema: z.ZodType, value: unknown, path = ''): IdRef[] {
  const brand = ID_BRANDS.get(schema)?.brand;
  if (brand !== undefined) return typeof value === 'string' ? [{ brand, id: value, path }] : [];
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return value === undefined || value === null || !def.innerType
        ? []
        : idsIn(def.innerType, value, path);
    case 'object':
      return isRecord(value)
        ? Object.entries(def.shape ?? {}).flatMap(([key, field]) =>
            idsIn(field, value[key], `${path}.${key}`),
          )
        : [];
    case 'array': {
      const { element } = def;
      return Array.isArray(value) && element
        ? value.flatMap((item, i) => idsIn(element, item, `${path}[${String(i)}]`))
        : [];
    }
    case 'tuple':
      return Array.isArray(value)
        ? value.flatMap((item, i) => {
            const field = def.items?.[i] ?? def.rest;
            return field ? idsIn(field, item, `${path}[${String(i)}]`) : [];
          })
        : [];
    case 'record': {
      const { keyType, valueType } = def;
      return isRecord(value) && keyType && valueType
        ? Object.entries(value).flatMap(([key, item]) => [
            ...idsIn(keyType, key, `${path}.${key}`),
            ...idsIn(valueType, item, `${path}.${key}`),
          ])
        : [];
    }
    case 'union': {
      // Parsed already, so the first option that takes the value is the one that did. If none
      // takes it (an option transformed it), which id it names can't be told.
      const option = def.options?.find((candidate) => candidate.safeParse(value).success);
      if (option) return idsIn(option, value, path);
      if (brandsIn(schema).length > 0) throw new UnreadableIds(path);
      return [];
    }
    case 'intersection':
      return def.left && def.right
        ? [...idsIn(def.left, value, path), ...idsIn(def.right, value, path)]
        : [];
    case 'pipe':
      // The parsed value is what `out` made. An id `in` checked may have changed on the way.
      if (def.in && brandsIn(def.in).length > 0) throw new UnreadableIds(path);
      return def.out ? idsIn(def.out, value, path) : [];
    case 'lazy':
      return def.getter ? idsIn(def.getter(), value, path) : [];
    default:
      return [];
  }
}
