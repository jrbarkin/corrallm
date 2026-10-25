import type { ProjectFolders } from '../../project';
import { ProjectDirectories } from './resolver';

/** Non-workspace core tests fake the directory seam, never spawning Git or allocating trees. */
export const legacyDirectories = (projects: ProjectFolders): ProjectDirectories =>
  new ProjectDirectories(projects);
