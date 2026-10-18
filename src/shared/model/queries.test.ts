import { describe, expect, it } from 'vitest';

import type { CanvasNode } from './canvas';
import { groupMembers, isGroup, managerOf, teamOf } from './queries';

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

describe('who manages whom', () => {
  const nodes = [
    node('lead', 'agent'),
    node('box', 'frame', 'lead'),
    node('worker', 'agent', 'box'),
    node('helper', 'agent', 'worker'),
    node('frame', 'frame'),
    node('loose', 'agent', 'frame'),
  ];

  it('makes an agent’s manager the nearest agent it is nested inside, through frames', () => {
    expect(managerOf(nodes, 'worker')).toBe('lead');
    expect(managerOf(nodes, 'helper')).toBe('worker');
    expect(managerOf(nodes, 'loose')).toBeUndefined();
    expect(managerOf(nodes, 'lead')).toBeUndefined();
  });

  it('makes an agent’s team every agent nested inside it, at any depth', () => {
    expect(teamOf(nodes, 'lead')).toEqual(['worker', 'helper']);
    expect(teamOf(nodes, 'worker')).toEqual(['helper']);
    expect(teamOf(nodes, 'loose')).toEqual([]);
  });
});
