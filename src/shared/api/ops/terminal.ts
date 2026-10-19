import { z } from 'zod';

import {
  MAX_DROPPED_FILES,
  MAX_DROPPED_PATH,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_INPUT,
  MAX_TERMINAL_ROWS,
} from '../../terminal';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId } from '../ids';
import type { OpName } from '../surface';

/** A window's terminal view (Core Server §4 K, D2–D4). */
const Agent = z.strictObject({ agent: AgentId });
const Done = z.strictObject({});

export const terminalOps = {
  'terminal.attach': define('terminal.attach', {
    summary:
      'Shows an agent’s terminal in this window, starting with its current screen and following its output until detached.',
    input: Agent,
    output: Done,
  }),
  'terminal.detach': define('terminal.detach', {
    summary: 'Stops showing an agent’s terminal in this window, leaving its session running.',
    input: Agent,
    output: Done,
  }),
  'terminal.input': define('terminal.input', {
    summary:
      'Passes the user’s keystrokes to an agent’s running terminal, including control characters.',
    input: Agent.extend({ data: z.string().min(1).max(MAX_TERMINAL_INPUT) }),
    output: Done,
  }),
  'terminal.resize': define('terminal.resize', {
    summary: 'Resizes an agent’s running terminal to this window’s view.',
    input: Agent.extend({
      cols: z.int().min(1).max(MAX_TERMINAL_COLS),
      rows: z.int().min(1).max(MAX_TERMINAL_ROWS),
    }),
    output: Done,
  }),
  'terminal.drop': define('terminal.drop', {
    summary:
      'Pastes existing files dropped on an agent’s terminal as quoted paths. The preload reads the paths from the dropped files.',
    input: Agent.extend({
      paths: z.array(z.string().min(1).max(MAX_DROPPED_PATH)).min(1).max(MAX_DROPPED_FILES),
    }),
    output: Done,
  }),
} satisfies Partial<Record<OpName, OpDef>>;
