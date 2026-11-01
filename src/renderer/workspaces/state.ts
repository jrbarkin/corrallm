import { createContext, useContext } from 'react';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type { ResultOf } from '../../shared/api/registry';
import type { CanvasNode } from '../../shared/model/canvas';

type Listed = ResultOf<'worktree.list'>;
export type Workspace = Listed['items'][number];
export type MergeInto = ResultOf<'branch.diff'>['into'];

/** Observation only. A job takes precedence over ancestry; nothing here runs Git. */
export function mergeMark(merge: Workspace['merge']): string {
  if (merge?.job === 'merging') return 'merging…';
  if (merge?.job === 'held') return 'Merge held';
  if (merge?.merged === true) return merge.uncommitted === 0 ? '· merged' : '· commits merged';
  return '';
}
export const Context = createContext<{
  canvas: CanvasId;
  client: GuiApi;
  state: Listed | undefined;
  nodes: readonly CanvasNode[];
  onNeed: (id: string) => void;
  needs: ResultOf<'needs'> | undefined;
  onBranch?: (agent: string, merge: boolean) => void;
  inert?: boolean;
} | null>(null);

export function useWorkspace(agent: string) {
  return useContext(Context)?.state?.items.find((item) => item.agent === agent);
}

export function useWorkspaces() {
  return useContext(Context)?.state?.items ?? [];
}

export function workspaceSharing(item: Workspace, nodes: readonly CanvasNode[]): string {
  if (item.mode === 'shared-folder') return 'Shared project folder';
  if (item.mode === 'own' || item.group === item.agent) return 'Own worktree';
  const label = nodes.find((node) => node.id === item.group)?.data.label;
  if (label !== undefined && label.length > 0) return `Shares ${label}’s worktree`;
  return `Shares ${item.group ?? 'group'}’s worktree`;
}

export function workspaceAttention(item: Workspace | undefined): boolean {
  return (
    !!item &&
    (item.state === 'setup' ||
      item.state === 'pending-change' ||
      item.state === 'missing' ||
      item.state === 'error')
  );
}

export function workspaceState(item: Workspace): string {
  if (item.state === 'setup') {
    switch (item.setup?.state) {
      case 'running':
        return 'Setting up worktree';
      case 'failed':
        return 'Worktree setup failed';
      case 'interrupted':
        return 'Worktree setup interrupted';
      default:
        return 'Waiting for worktree setup';
    }
  }
  return {
    'no-project': 'Choose a project folder',
    unmade: 'Worktree not made yet',
    creating: 'Creating worktree',
    ready: item.mode === 'shared-folder' ? 'Shared project folder' : 'Worktree ready',
    'pending-change': 'Waiting to switch worktrees',
    missing: 'Worktree missing',
    error: 'Worktree failed',
  }[item.state];
}
