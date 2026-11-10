import type { NodeLike } from '../../shared/model/canvas';

/**
 * The agents `agent` is nested inside, nearest first (B24 R28: the walk only goes up, and a loop in
 * the ancestry, which a canvas file can't make, gives none at all). Routing a prompt and resolving
 * a manager share it.
 */
export function ancestorsOf(nodes: readonly NodeLike[], agent: string): string[] | undefined {
  const seen = new Set([agent]);
  const chain: string[] = [];
  let parent = nodes.find((node) => node.id === agent)?.parentId;
  while (parent !== undefined) {
    if (seen.has(parent)) return undefined;
    seen.add(parent);
    const node = nodes.find((one) => one.id === parent);
    if (node?.type === 'agent') chain.push(node.id);
    parent = node?.parentId;
  }
  return chain;
}
