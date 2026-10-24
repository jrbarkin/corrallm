import { z } from 'zod';

import { MAX_NODE_ID } from '../model/canvas';
import { MAX_NEED_ID } from './limits';

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
  | 'GroupId'
  | 'ItemId'
  | 'EntityKey'
  | 'NeedId'
  | 'MessageId'
  | 'ConversationId'
  | 'EntryId'
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

/**
 * A Needs item (API Spec §5.9), by its id on its canvas: what it is, then its agent's id (escaped)
 * and what of the agent's it is (src/shared/engine/needs.ts), or a proposal's or a file review's
 * own id. A proposal returns one.
 */
export const NeedId = brandedId(
  'NeedId',
  z
    .string()
    .max(MAX_NEED_ID)
    .regex(/^(?:hold|start|unasking|limited|prompt|proposal|file|stalled|setup)\/[\s\S]+$/),
);
export type NeedId = z.infer<typeof NeedId>;

/** A canvas, by its stable id (src/shared/canvas.ts). */
export const CanvasId = brandedId('CanvasId', z.uuid());
export type CanvasId = z.infer<typeof CanvasId>;

/**
 * The canvas an op acts on, which a caller with exactly one may leave out (an agent's own, a
 * token's only one, the only one you have open), and so may one naming a message, whose canvas it
 * says: core.call fills it in.
 */
export const OpCanvas = CanvasId.optional();

/** An agent of a canvas, by its node's id. */
export const AgentId = brandedId('AgentId', z.string().min(1).max(MAX_NODE_ID));
export type AgentId = z.infer<typeof AgentId>;

/** A node of a canvas, by its id: an agent, as itself, or a frame, as every agent inside it. */
export const NodeId = brandedId('NodeId', z.string().min(1).max(MAX_NODE_ID));
export type NodeId = z.infer<typeof NodeId>;

/** A group of a canvas, by its node's id: a frame, or an agent with agents inside it, and all of them. */
export const GroupId = brandedId('GroupId', z.string().min(1).max(MAX_NODE_ID));
export type GroupId = z.infer<typeof GroupId>;

/**
 * An item of an agent's queue, at any depth (inside an if-then or a repeat), by its id: named
 * beside the agent whose queue holds it (`agent`, an AgentId in the same object).
 */
export const ItemId = brandedId('ItemId', z.string().min(1).max(MAX_NODE_ID));
export type ItemId = z.infer<typeof ItemId>;

/** A message (API Spec §5.2), by the id the core minted. */
export const MessageId = brandedId('MessageId', z.uuid());
export type MessageId = z.infer<typeof MessageId>;

/** Native ids meet R42a's platform minimum; the adapter applies its stricter shape later. */
const NativeId = () =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^(?!-)[A-Za-z0-9._:-]+$/);
export const ConversationId = brandedId('ConversationId', NativeId());
export const TaskId = brandedId('TaskId', NativeId());
/** A native transcript message/checkpoint, beside its agent; not a durable mailbox UUID. */
export const EntryId = brandedId('EntryId', NativeId());

/**
 * An entity of a canvas's document, by its key (src/shared/model/rows.ts): `node/<id>`,
 * `link/<a>/<b>` or `item/<agent>/<id>`, each id escaped (up to 9 characters for each of its own).
 */
export const EntityKey = brandedId(
  'EntityKey',
  z
    .string()
    .max('item/'.length + 2 * 9 * MAX_NODE_ID + 1)
    .regex(/^(?:node|link|item)\//),
);
export type EntityKey = z.infer<typeof EntityKey>;

/** A branded id found in an op's arguments: its brand, its value, where it was, and if a key. */
export interface IdRef {
  brand: Brand;
  id: string;
  path: string;
  /** Whether it keys a map, rather than being a value. */
  key?: true;
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
            ...idsIn(keyType, key, `${path}.${key}`).map((ref) => ({ ...ref, key: true as const })),
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
