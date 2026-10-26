import { z } from 'zod';

import { ELICITATION_ACTIONS } from '../../session';
import { define } from '../define';
import type { OpDef } from '../define';
import { AgentId, OpCanvas } from '../ids';
import { MAX_PAGE } from '../limits';
import type { OpName } from '../surface';
import { TurnResult } from './conversation';
import { ConversationId, EntryId, TaskId } from '../ids';
import {
  CatalogId,
  Effort as EffortValue,
  ManualText,
  Model,
  ModelChoice,
  SessionSummarySchema,
} from './b11-data';
import {
  MCP_CHANGES,
  MCP_STATUSES,
  REWIND_RESTORES,
  MAX_MCP_ERROR_LENGTH,
  MAX_MCP_NAME_LENGTH,
  MAX_MCP_SERVERS,
} from '../../session';

/** Sessions (Core Server §4 G): an agent's session as it is, its transcript, and interrupting it. */

const canvas = OpCanvas;

const ToolDetail = z.union([
  z.strictObject({
    kind: z.literal('diff'),
    added: z.number(),
    removed: z.number(),
    lines: z.array(z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() })),
  }),
  z.strictObject({ kind: z.literal('output'), text: z.string() }),
]);

const Question = z.strictObject({
  header: z.string(),
  text: z.string(),
  options: z.array(z.strictObject({ label: z.string(), description: z.string() })),
  multiple: z.boolean(),
  answer: z.string().optional(),
});

/** Whether an entry is withdrawn: a prompt the session stopped waiting for. */
const withdrawn = z.boolean().optional();

/**
 * Whether an entry was cut to fit its page (MAX_PAGE_BYTES): its text, plan, output or diff ends
 * early, or, for an entry still too big, every text in it, and then every list. The whole of it
 * stays in the session.
 */
const cut = z.literal(true).optional();

/**
 * An entry of an agent's transcript, as its view shows it (src/shared/model/session.ts Entry). A
 * message's pasted images are only counted, and an entry too big for a page alone is `cut`.
 */
export const TranscriptEntry = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.string(),
    kind: z.literal('user'),
    text: z.string(),
    images: z.int().optional(),
    reached: z.literal(true).optional(),
    conversation: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('text'),
    text: z.string(),
    parent: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('thinking'),
    text: z.string(),
    seconds: z.number(),
    parent: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('tool'),
    tool: z.string(),
    summary: z.string(),
    status: z.enum(['running', 'done', 'failed', 'interrupted']),
    detail: ToolDetail.optional(),
    parent: z.string().optional(),
    progress: z
      .strictObject({
        seconds: z.number().optional(),
        doing: z.string().optional(),
        toolUses: z.number().optional(),
        tokens: z.number().optional(),
      })
      .optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('permission'),
    tool: z.string(),
    summary: z.string(),
    detail: ToolDetail.optional(),
    always: z.string().nullable().optional(),
    title: z.string().optional(),
    answer: z.enum(['once', 'always', 'deny']).optional(),
    feedback: z.string().optional(),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('question'),
    questions: z.array(Question),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('plan'),
    plan: z.string(),
    answer: z
      .union([
        z.strictObject({ approve: z.literal(true), mode: z.string() }),
        z.strictObject({ approve: z.literal(false), feedback: z.string() }),
      ])
      .optional(),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('todos'),
    items: z.array(
      z.strictObject({ text: z.string(), status: z.enum(['pending', 'active', 'done']) }),
    ),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('elicitation'),
    server: z.string(),
    message: z.string(),
    fields: z.array(z.record(z.string(), z.unknown())).optional(),
    url: z.string().optional(),
    answer: z.enum(ELICITATION_ACTIONS).optional(),
    withdrawn,
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
    switchTo: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('cleared'),
    conversation: z.string().optional(),
    cut,
  }),
  z.strictObject({
    id: z.string(),
    kind: z.literal('end'),
    seconds: z.number(),
    interrupted: z.boolean(),
    failed: z.boolean().optional(),
    result: TurnResult.optional(),
    cut,
  }),
]);

export const sessionOps = {
  'session.get': define('session.get', {
    summary:
      'An agent’s session as it is now: whether it works, waits for the user or is idle, what ' +
      'is queued and asked, the model, mode and effort it runs, what it runs in the background, ' +
      'what it has used, and up to 4 KiB of its last reply (replyCut says more is in the transcript).',
    input: z.strictObject({ canvas, agent: AgentId }),
    output: SessionSummarySchema,
  }),
  'session.transcript': define('session.transcript', {
    summary:
      'An agent’s transcript, a page at a time, oldest first: pass the `next` a call returned as ' +
      '`after` to read on. A page ends early rather than grow too big for one result, and an ' +
      'entry too big alone comes cut, marked `cut`.',
    input: z.strictObject({
      canvas,
      agent: AgentId,
      after: z.string().min(1).max(512).optional(),
      limit: z.int().min(1).max(MAX_PAGE).optional(),
    }),
    output: z.strictObject({
      entries: z.array(TranscriptEntry),
      next: z.string().nullable(),
    }),
  }),
  'session.interrupt': define('session.interrupt', {
    summary:
      'Interrupts the turn an agent’s session is on, as Escape does in its CLI; what it asks ' +
      'the user then is withdrawn.',
    input: z.strictObject({ canvas, agent: AgentId }),
    output: z.strictObject({}),
  }),
} satisfies Partial<Record<OpName, OpDef>>;

export { SessionSummarySchema } from './b11-data';
const AgentInput = z.strictObject({ canvas, agent: AgentId });
const RewindInput = z.strictObject({ canvas, agent: AgentId, message: EntryId });
const FilesRewind = z.strictObject({
  possible: z.boolean(),
  error: z.string().optional(),
  files: z.array(z.string()),
  added: z.number(),
  removed: z.number(),
});
const ServerName = z.string().min(1).max(MAX_MCP_NAME_LENGTH);
/** An MCP server a session reports, as /mcp shows it: bounded by the core (MAX_MCP_SERVERS). */
const McpServers = z
  .array(
    z.strictObject({
      name: ServerName,
      status: z.enum(MCP_STATUSES),
      scope: z.string().max(MAX_MCP_NAME_LENGTH).optional(),
      server: z.string().max(MAX_MCP_NAME_LENGTH).optional(),
      tools: z.number().optional(),
      error: z.string().max(MAX_MCP_ERROR_LENGTH).optional(),
    }),
  )
  .max(MAX_MCP_SERVERS);
const PastSession = z.strictObject({
  id: ConversationId,
  title: z.string(),
  modified: z.number(),
  bytes: z.number().optional(),
  branch: z.string().optional(),
  current: z.boolean(),
});

/** B11 schemas: C6 lifecycle/settings/rewind operations are registered; conversation/options and MCP controls await their services. */
export const b11SessionOps = {
  'session.open': define(
    { kind: 'command' },
    {
      summary: 'Ensures the agent’s session is open using core-owned settings and cwd.',
      input: AgentInput,
      output: z.strictObject({}),
    },
  ),
  'session.setMode': define(
    { kind: 'command' },
    {
      summary: 'Changes the live mode and its saved setting, as the user only.',
      input: AgentInput.extend({ mode: CatalogId }),
      output: z.strictObject({}),
    },
  ),
  'session.setModel': define(
    { kind: 'command' },
    {
      summary: 'Changes the live and saved model.',
      input: AgentInput.extend({ model: Model }),
      output: z.strictObject({}),
    },
  ),
  'session.setEffort': define(
    { kind: 'command' },
    {
      summary: 'Changes the live and saved effort; null uses the model’s default.',
      input: AgentInput.extend({ effort: EffortValue.nullable() }),
      output: z.strictObject({}),
    },
  ),
  'session.stopTask': define(
    { kind: 'command' },
    {
      summary: 'Stops a background task the session reports.',
      input: AgentInput.extend({ task: TaskId }),
      output: z.strictObject({}),
    },
  ),
  'session.restart': define(
    { kind: 'command' },
    {
      summary: 'Restarts an idle session with current saved settings.',
      input: AgentInput,
      output: z.strictObject({}),
    },
  ),
  'session.newConversation': define(
    { kind: 'command' },
    {
      summary: 'Starts a new conversation without deleting native history.',
      input: AgentInput,
      output: z.strictObject({}),
    },
  ),
  'session.conversations': define(
    { kind: 'read' },
    {
      summary: 'Lists this adapter’s conversations in this agent’s verified workspace.',
      input: AgentInput,
      output: z.strictObject({ items: z.array(PastSession) }),
    },
  ),
  'session.resumeConversation': define(
    { kind: 'command' },
    {
      summary: 'Resumes an admitted conversation that no running session claims.',
      input: AgentInput.extend({ conversation: ConversationId }),
      output: z.strictObject({}),
    },
  ),
  'session.rewindPreview': define(
    { kind: 'read' },
    {
      summary: 'Previews file restoration before a native transcript message.',
      input: RewindInput,
      output: FilesRewind,
    },
  ),
  'session.rewind': define(
    { kind: 'command', rules: ['restore-code'] },
    {
      summary: 'Rewinds files, conversation or both; a token’s code restoration proposes first.',
      input: RewindInput.extend({ restore: z.enum(REWIND_RESTORES) }),
      output: z.strictObject({ files: FilesRewind.optional(), conversation: z.boolean() }),
    },
  ),
  'session.mcpServers': define(
    { kind: 'read' },
    {
      summary:
        'Lists the MCP servers an agent’s running session has, and how each is (/mcp): on a ' +
        'connection whose view shows them.',
      input: AgentInput,
      output: z.strictObject({ items: McpServers }),
    },
  ),
  'session.changeMcpServer': define(
    { kind: 'command' },
    {
      summary:
        'Reconnects, enables or disables one MCP server the agent’s session reports, saying so ' +
        'in its transcript. Returns its servers as they are then.',
      input: AgentInput.extend({ server: ServerName, change: z.enum(MCP_CHANGES) }),
      output: z.strictObject({ items: McpServers }),
    },
  ),
  'session.options': define(
    { kind: 'read' },
    {
      summary: 'Reads the adapter’s options and user defaults in the optional agent workspace.',
      input: z.strictObject({ canvas, agent: AgentId.optional(), adapter: CatalogId }),
      output: z.strictObject({
        models: z.array(ModelChoice),
        defaults: z.strictObject({
          model: z.string().nullable(),
          effort: z.string().nullable(),
          mode: z.string().nullable(),
          asks: z.boolean().optional(),
        }),
      }),
    },
  ),
  'session.continueIn': define(
    { kind: 'command' },
    {
      summary:
        'Switches connection, opens it and sends optional manual input once, as the user only.',
      input: AgentInput.extend({ connection: CatalogId, then: ManualText.optional() }),
      output: z.strictObject({ id: z.uuid().optional() }),
    },
  ),
};
