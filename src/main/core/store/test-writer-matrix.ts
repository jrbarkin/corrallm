import { OPEN_DEFAULTS } from './open';

/*
 * The writer matrix (Store Writer, step 6a): a setup file for the `main-writer` project
 * (vitest.config.ts), which runs the store, core and delivery suites with every store handed to
 * the writer's thread unless a test says otherwise. 6b flips the default with this evidence.
 */
OPEN_DEFAULTS.writer = true;
