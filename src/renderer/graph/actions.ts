import { createContext, useContext } from 'react';

/** What node and edge views can do to the graph. GraphEditor provides them. */
export interface GraphActions {
  /** The node whose label is being edited in place, if any. */
  editing: string | undefined;
  startEditing: (id: string) => void;
  stopEditing: () => void;
  rename: (id: string, label: string) => void;
  remove: (id: string) => void;
  /** A container's children move out of it; any other node moves out of its container. */
  ungroup: (id: string) => void;
  addParent: (id: string) => void;
  removeEdge: (id: string) => void;
  /** Opens the work queued from one agent for another (WorkDetail.tsx). */
  openWork: (from: string, to: string) => void;
}

export const GraphActionsContext = createContext<GraphActions | null>(null);

export function useGraphActions(): GraphActions {
  const actions = useContext(GraphActionsContext);
  if (!actions) throw new Error('useGraphActions is only available inside GraphEditor');
  return actions;
}
