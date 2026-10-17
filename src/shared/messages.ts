import type { TurnResult } from './session';

/*
 * What passes between parties in corrallm: agents, you, and an orchestrator outside it. One
 * envelope, in a few kinds. A message waits for whoever it is to until they are free to take it
 * (an agent, as a turn; you, in Needs you), and an answer to it is a message too, naming it as
 * `replyTo`. A CLI's own prompts (a permission, a question, a plan, an MCP form) are messages to the
 * agent's manager, and answering one answers the prompt.
 */

/**
 * text: a message, a hand-off. question: text, with choices or a free answer. approval: a CLI's
 * permission prompt. plan: a plan proposed before acting. form: an MCP server's form or link.
 * result: how a task went, for corrallm to read.
 */
export const MESSAGE_KINDS = ['text', 'question', 'approval', 'plan', 'form', 'result'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** A choice a question or a prompt offers: what it is called, and what it means. */
export interface MessageChoice {
  /** What answering with it is called: its id among the message's choices. */
  value: string;
  label: string;
  description?: string;
}

export interface Message {
  id: string;
  /** Who sent it, and who it is for: an agent's name, or "you". */
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  /** What it may be answered with; none for a free answer, or for a text message. */
  choices?: MessageChoice[];
  /** Whether several of its choices may be picked. */
  multiple?: boolean;
  /** The message it answers, or the one whose turn raised it. */
  replyTo?: string;
  /** When an answer stops being waited for (epoch ms): then the turn that asked is interrupted. */
  deadline?: number;
  /** For an agent's reply: how its turn ended. */
  result?: TurnResult;
  /** When it was sent (epoch ms). */
  at: number;
}

/** Who a message is for when it is for the person (or orchestrator) managing the agents. */
export const YOU = 'you';
