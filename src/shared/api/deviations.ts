import type { OpName } from './surface';

/*
 * The operations on one surface only, and why (Core Server §3.5). By default an operation is on
 * both: the GUI's if you are in its audience, MCP's if any other party is. A test fails on any
 * other difference not listed here, and on a row whose op no longer differs.
 */

/** Why an operation may be on one surface only: a closed list, each with its sentence. */
export const REASONS = {
  'trust-gate':
    'A path comes only from a native dialog you complete: that choice is the trust gate.',
  'os-action': 'It acts on your desktop after your click, or reads the files you dropped.',
  'acts-as-you': 'Keystrokes into a CLI’s own interface answer what it asks there, as you.',
  view: 'It serves a window’s view: a terminal widget, or which canvas a window shows.',
  transport: 'The GUI is pushed what changes; MCP can’t push, so a token waits for what is for it.',
  'spending-guard': 'Usage rules are yours: an agent could otherwise defeat its own guard.',
  credentials: 'A person makes tokens, sees each once and may revoke them; no token makes one.',
  consent: 'Consent is yours alone to give.',
  permissions: 'Who leads, and what an agent runs as (its mode, connection and CLI), are yours.',
  'caller-bound':
    'It acts for the calling agent itself, which neither you nor an outside caller is.',
} as const;
export type Reason = keyof typeof REASONS;

/** Each operation on one surface only, with its reason. */
export const DEVIATIONS: Partial<Record<OpName, Reason>> = {
  'usage.setRule': 'spending-guard',
  'usage.simulate': 'spending-guard',
  'link.open': 'os-action',
  'link.reveal': 'os-action',
  'window.get': 'view',
  'terminal.attach': 'view',
  'terminal.detach': 'view',
  'terminal.input': 'acts-as-you',
  'terminal.resize': 'view',
  'terminal.drop': 'os-action',
  // The GUI's half, topics, comes with B8.
  wait: 'transport',
};
