import type { Link, NodeLike } from './canvas';

/** Frames are groups even when empty; an agent becomes a group when it has children. */
export function isGroup(nodes: readonly NodeLike[], id: string): boolean {
  const node = nodes.find((node) => node.id === id);
  return (
    node?.type === 'frame' ||
    (node?.type === 'agent' && nodes.some((child) => child.parentId === id))
  );
}

/** The group's agents, including an agent parent, in their order on the canvas. */
export function groupMembers(nodes: readonly NodeLike[], id: string): string[] {
  if (!isGroup(nodes, id)) return [];
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else children.set(node.parentId, [node.id]);
  }

  const members = new Set<string>();
  const pending = [id];
  for (const next of pending) {
    if (members.has(next)) continue;
    members.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return nodes
    .filter((node) => node.type === 'agent' && members.has(node.id))
    .map((node) => node.id);
}

/** An agent's name: its label, "Unnamed agent" without one, or "Deleted agent" once it is gone. */
export function agentName(nodes: readonly NodeLike[], id: string): string {
  const node = nodes.find((n) => n.id === id);
  return node ? node.data.label || 'Unnamed agent' : 'Deleted agent';
}

/** Whether agents `a` and `b` are linked (can talk to each other), whichever way it was drawn. */
export function areLinked(
  links: readonly Pick<Link, 'source' | 'target'>[],
  a: string,
  b: string,
): boolean {
  return links.some(
    (l) => (l.source === a && l.target === b) || (l.source === b && l.target === a),
  );
}
