import type { OpName } from './surface';

/*
 * The operations registered for the GUI (you are in their audience) that the app doesn't serve
 * over IPC yet, each with the phase that brings it there (Build Plan §2.2, Q1). Until then such an
 * op is on MCP alone, which the registry's tests accept only while it is listed here. B8 and B11
 * shrink the list; B11 empties and deletes it, and the tests are strict from then on.
 */
export const UNHOSTED: Partial<Record<OpName, 'B8' | 'B11'>> = {
  'app.info': 'B8',
  'catalog.get': 'B8',
  'catalog.installed': 'B8',
  'settings.get': 'B8',
  agents: 'B11',
  status: 'B11',
  needs: 'B11',
  messages: 'B11',
  message: 'B11',
  withdraw: 'B11',
  'session.get': 'B11',
  'session.transcript': 'B11',
  'session.interrupt': 'B11',
  'run.pause': 'B11',
  'run.kill': 'B11',
  'run.unpause': 'B11',
  'usage.get': 'B8',
};
