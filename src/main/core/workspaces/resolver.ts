import type { AgentId, NeedId } from '../../../shared/api/ids';
import type { CanvasId } from '../../../shared/canvas';
import type { ProjectFolders } from '../../project';
import type { TrustedPath } from '../host';
import type { WorktreeRecord } from './store';

/** The workspace id kept by schema 3, not a path or a desired owner key. */
export type WorkspaceId = WorktreeRecord['id'];

export type WorkingDirectory =
  | {
      state: 'ready';
      cwd: TrustedPath;
      workspace: WorkspaceId | null;
      /** The active binding's generation, never the desired plan's. */
      generation: number;
      branch: string | null;
    }
  | {
      state: 'held';
      reason: 'no-project' | 'creating' | 'setup' | 'pending-change' | 'missing' | 'error';
      need?: NeedId;
      sentence: string;
    };

export interface WorkingDirectoryResolver {
  workingDirectory(canvas: CanvasId, agent: AgentId): Promise<WorkingDirectory>;
  onAvailability(canvas: CanvasId, listener: () => void): () => void;
}

/** Base reads without an agent, host admission and root comparison use the picked project. */
export interface ProjectRootResolver {
  projectRoot(canvas: CanvasId): TrustedPath | undefined;
}

export type DirectoryResolver = WorkingDirectoryResolver & ProjectRootResolver;

/** A non-repository (and isolated tests) shares the picked folder. */
export class ProjectDirectories implements DirectoryResolver {
  readonly #projects: Pick<ProjectFolders, 'of' | 'onAvailability'>;

  constructor(projects: Pick<ProjectFolders, 'of' | 'onAvailability'>) {
    this.#projects = projects;
  }

  workingDirectory(...[canvas]: [canvas: CanvasId, agent: AgentId]): Promise<WorkingDirectory> {
    // The legacy folder is shared by every agent; WorkspaceDirectories supplies repository bindings.
    const cwd = this.#projects.of(canvas);
    return Promise.resolve(
      cwd === undefined
        ? {
            state: 'held',
            reason: 'no-project',
            sentence:
              'Choose a project folder for this canvas first (in the bar at the top left): its agents work in it.',
          }
        : { state: 'ready', cwd, workspace: null, generation: 0, branch: null },
    );
  }

  projectRoot(canvas: CanvasId): TrustedPath | undefined {
    return this.#projects.of(canvas);
  }

  onAvailability(canvas: CanvasId, listener: () => void): () => void {
    return this.#projects.onAvailability(canvas, listener);
  }
}
