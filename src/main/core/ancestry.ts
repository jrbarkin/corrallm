import type { Catalog } from '../../shared/adapter';
import type { LeadGrants } from '../../shared/api/ops/leads';
import { agentEndpoint } from '../../shared/model/catalog';
import type { CanvasNode, NodeLike } from '../../shared/model/canvas';
import { connectionIn } from '../../shared/adapter';

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

/**
 * B24 C4: whether `lead` may take its team's questions now: it leads (`grants` are what the lead
 * store gives it now, none if it does not or is held), holds the questions grant, and its
 * connection has an API route to answer them through. The one reading manager resolution uses,
 * in the core and in tests over a made-up catalog.
 */
export function managesQuestions(
  catalog: Catalog,
  grants: LeadGrants | undefined,
  nodes: readonly CanvasNode[] | undefined,
  lead: string,
): boolean {
  if (grants?.questions !== true) return false;
  const node = nodes?.find((one) => one.id === lead && one.type === 'agent');
  const endpoint = node?.type === 'agent' ? agentEndpoint(node.data, catalog) : undefined;
  return (
    endpoint?.kind === 'known' && connectionIn(catalog, endpoint.connection)?.connection.api != null
  );
}
