import { describe, expect, it } from 'vitest';

import type { CanvasNode } from './canvas';
import { groupMembers, isGroup } from './queries';

const node = (id: string, type: 'agent' | 'frame', parentId?: string): CanvasNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id },
  ...(parentId === undefined ? {} : { parentId }),
});

describe('group membership', () => {
  it('recognizes empty frames and agents with direct children', () => {
    const nodes = [
      node('empty', 'frame'),
      node('lead', 'agent'),
      node('inner', 'frame', 'lead'),
      node('alone', 'agent'),
      node('orphan', 'agent', 'missing'),
    ];
    expect(isGroup(nodes, 'empty')).toBe(true);
    expect(isGroup(nodes, 'lead')).toBe(true);
    expect(isGroup(nodes, 'inner')).toBe(true);
    expect(isGroup(nodes, 'alone')).toBe(false);
    expect(isGroup(nodes, 'missing')).toBe(false);
    expect(groupMembers(nodes, 'empty')).toEqual([]);
    expect(groupMembers(nodes, 'alone')).toEqual([]);
    expect(groupMembers(nodes, 'missing')).toEqual([]);
  });

  it('finds all descendant agents through nested frames in nodes order', () => {
    const nodes = [
      node('deep', 'agent', 'nested'),
      node('outside', 'agent'),
      node('team', 'frame'),
      node('second', 'agent', 'team'),
      node('nested', 'frame', 'team'),
      node('first', 'agent', 'team'),
    ];
    expect(groupMembers(nodes, 'team')).toEqual(['deep', 'second', 'first']);
    expect(groupMembers(nodes, 'nested')).toEqual(['deep']);
  });

  it('includes an agent parent and its nested agent groups once', () => {
    const nodes = [
      node('worker', 'agent', 'lead'),
      node('lead', 'agent'),
      node('sublead', 'agent', 'lead'),
      node('subworker', 'agent', 'sublead'),
    ];
    expect(groupMembers(nodes, 'lead')).toEqual(['worker', 'lead', 'sublead', 'subworker']);
    expect(groupMembers(nodes, 'sublead')).toEqual(['sublead', 'subworker']);
  });

  it('terminates at parent cycles and keeps each reachable agent once', () => {
    const nodes = [
      node('b', 'agent', 'a'),
      node('a', 'agent', 'b'),
      node('outer', 'frame', 'inner'),
      node('inner', 'frame', 'outer'),
      node('worker', 'agent', 'inner'),
    ];
    expect(groupMembers(nodes, 'a')).toEqual(['b', 'a']);
    expect(groupMembers(nodes, 'outer')).toEqual(['worker']);
  });
});
