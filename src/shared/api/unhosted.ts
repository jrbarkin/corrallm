import type { OpName } from './surface';

/*
 * The operations registered for the GUI (you are in their audience) that the app doesn't serve
 * over IPC yet, each with the phase that brings it there (Build Plan §2.2, Q1). Until then such an
 * op is on MCP alone, which the registry's tests accept only while it is listed here. B8 and B11
 * shrink the list; B11 empties and deletes it, and the tests are strict from then on.
 */
export const UNHOSTED: Partial<Record<OpName, 'B8' | 'B11'>> = {
  'app.info': 'B8',
  'usage.get': 'B8',
};
