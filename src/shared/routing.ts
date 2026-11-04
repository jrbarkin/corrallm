import type { ConnectionDescriptor, ContinuationCommand } from './adapter';
import { startsWithShell } from './model/catalog';
import type { SlashCommand } from './session';

/*
 * Where a message's text goes (B16 C2): one pure decision, read from the connection's descriptor
 * alone, that the composer's completion and interception and the core's admission of `message`
 * all share. In order:
 *
 * 1. A command its view answers in a panel its connection declares (`panels`: /resume, /mcp,
 *    /rewind), which is never sent: where its session can't use that panel now (`features`), the
 *    view says so, and the core refuses it the same, so both decide by the same declaration.
 * 2. A command only its `continueIn` connection runs, or (where that connection takes them) text
 *    starting with that connection's own shell prefix and a command after it: continued there,
 *    never sent here. A command the session offers itself wins, except a bare-only continuation
 *    command typed bare.
 * 3. A command the session offers (`commands`): sent, as it is.
 * 4. Anything else: sent, as it is. A path starting with `/` is just text.
 *
 * It reads the text as given and changes none of it: what a route sends or continues is the input,
 * whitespace and lines included. It names no agent.
 */

/** The commands a view can answer itself, each a panel a connection may declare. */
export const PANELS = ['resume', 'mcp', 'rewind'] as const;
export type Panel = (typeof PANELS)[number];

/** Where a message's text goes. */
export type Route =
  /** Its view's panel answers it: recorded as your command (`session.viewCommand`), never sent. */
  | { kind: 'panel'; panel: Panel }
  /** It runs only in the `continueIn` connection: continued there (`session.continueIn`). */
  | { kind: 'continue'; connection: string; command: ContinuationCommand }
  /** A shell command only the `continueIn` connection runs (its own prefix first): continued there. */
  | { kind: 'shell'; connection: string; command: string }
  /** A command the session offers itself: sent as typed. */
  | { kind: 'command'; name: string }
  /** Text: sent as typed. */
  | { kind: 'send' };

/** A message's command, if it is one: its name, and what follows it, trimmed. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  return name === undefined ? undefined : { name, args: match?.[2]?.trim() ?? '' };
}

/** What a route is decided over: the connection the agent runs, and what its session offers. */
export interface RouteContext {
  /** The agent's connection's descriptor (its `panels` and `continueIn`). */
  connection: Pick<ConnectionDescriptor, 'panels' | 'continueIn'>;
  /** Its `continueIn` connection's descriptor: whose shell prefix a shell command starts with. */
  target?: Pick<ConnectionDescriptor, 'shellPrefix'> | undefined;
  /** The commands its session offers now (`commands`): none known, none offered. */
  offered?: readonly SlashCommand[] | undefined;
}

/** Where `text` goes for an agent whose connection and session `context` describes. */
export function routeOf(text: string, context: RouteContext): Route {
  const { connection, target, offered } = context;
  const typed = parseCommand(text);
  const panel = PANELS.find((one) => one === typed?.name);
  if (panel !== undefined && Object.hasOwn(connection.panels, panel)) {
    return { kind: 'panel', panel };
  }
  const own = typed !== undefined && (offered?.some(({ name }) => name === typed.name) ?? false);
  const continueIn = connection.continueIn;
  if (continueIn !== undefined) {
    const command =
      typed === undefined ? undefined : continueIn.commands.find(({ name }) => name === typed.name);
    // The session's own command of that name runs, unless this one runs typed bare and it was.
    if (command !== undefined && (!own || (command.bare === true && typed.args === ''))) {
      return { kind: 'continue', connection: continueIn.connection, command };
    }
    const prefix = target?.shellPrefix;
    if (continueIn.shell && startsWithShell(text, prefix)) {
      const shell = text.trimStart().slice(prefix.length).trim();
      // Its prefix alone is no command: it is text.
      if (shell !== '') return { kind: 'shell', connection: continueIn.connection, command: shell };
    }
  }
  return own ? { kind: 'command', name: typed.name } : { kind: 'send' };
}

/** The operations that answer each panel, as a refusal names them. */
const PANEL_OPS: Readonly<Record<Panel, string>> = {
  resume:
    'list its conversations with session.conversations and resume one with session.resumeConversation',
  mcp: 'read its servers with session.mcpServers and change one with session.changeMcpServer',
  rewind: 'preview with session.rewindPreview and rewind with session.rewind',
};

/**
 * Why a `message` carrying text its route doesn't send is refused (the API Spec's §5.6 routing,
 * the same for every caller): a panel's command names its operations; a continuation command or
 * shell command says it runs once you switch the agent's connection, which only you do. `agent` is
 * the agent as a sentence names it, `target` its `continueIn` connection's name in full. None for
 * a route that sends.
 */
export function routeRefusal(route: Route, agent: string, target: string): string | undefined {
  switch (route.kind) {
    case 'panel':
      return `${agent}’s /${route.panel} is answered by its view, never sent as a message: ${PANEL_OPS[route.panel]}.`;
    case 'continue':
      return `/${route.command.name} runs only in ${agent}’s ${target}: it runs there once you switch the agent to it (session.continueIn), which only you do.`;
    case 'shell':
      return `That shell command runs only in ${agent}’s ${target}: it runs there once you switch the agent to it (session.continueIn), which only you do.`;
    case 'command':
    case 'send':
      return undefined;
  }
}
