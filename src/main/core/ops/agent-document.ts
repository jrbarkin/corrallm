import type { AgentNode, CanvasDocument } from '../../../shared/model/canvas';
import { OpFailure } from '../call';

/** Pure builds must distinguish absent agents from nodes of another kind. */
export function requireAgent(doc: CanvasDocument, id: string): AgentNode {
  const node = doc.nodes.find((one) => one.id === id);
  if (!node) throw new OpFailure('not-found', `There is no agent ${id}.`);
  if (node.type !== 'agent') throw new OpFailure('invalid', `Node ${id} is not an agent.`);
  return node;
}

type Defined<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends (infer V)[]
    ? Defined<V>[]
    : { [K in keyof T]: Defined<Exclude<T[K], undefined>> };

/** Zod's optional fields also admit explicit undefined; the model keeps absent fields absent. */
export function withoutUndefined<T>(value: T): Defined<T> {
  if (Array.isArray(value))
    return (value as unknown[]).map((one) => withoutUndefined(one)) as Defined<T>;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, one]) => one !== undefined)
        .map(([key, one]) => [key, withoutUndefined(one)]),
    ) as Defined<T>;
  return value as Defined<T>;
}
