import { randomUUID } from 'node:crypto';

import type { SessionEvent, UserMessage } from '../../../shared/session';
import type { MessageStore } from './messages';

/** Withdrawal notes at the CLI boundary, including canvases whose run stays in the renderer. */
export class WithdrawalNotes {
  readonly #store: MessageStore;
  readonly #prefixes: readonly string[];
  readonly #carrying = new Map<string, { agent: string; ids: string[]; ended?: () => void }>();
  #closed = false;

  constructor(store: MessageStore, prefixes: readonly string[]) {
    this.#store = store;
    this.#prefixes = prefixes;
  }

  close(): void {
    this.#closed = true;
    for (const carrying of this.#carrying.values()) carrying.ended?.();
    this.#carrying.clear();
  }

  /**
   * Sends the next CLI message with any withdrawals still untold. Done at the backend, after
   * the session's queue, so manual and run messages, and messages already queued, carry them too.
   */
  async send(
    agent: string,
    message: UserMessage,
    send: (message: UserMessage) => Promise<void>,
  ): Promise<void> {
    const sendOpen = (next: UserMessage) => {
      if (this.#closed) throw new Error('The canvas closed before its message could be sent.');
      return send(next);
    };
    const claimed = new Set([...this.#carrying.values()].flatMap(({ ids }) => ids));
    const notes = this.#store.withdrawals(`agent:${agent}`).filter(({ id }) => !claimed.has(id));
    if (notes.length === 0) return sendOpen(message);
    const text = notes.map(({ text }) => text).join('\n');
    const command =
      message.from === undefined &&
      (message.text.trimStart().startsWith('/') ||
        this.#prefixes.some((prefix) => message.text.trimStart().startsWith(prefix)));
    const id = command ? randomUUID() : message.id;
    let ended: (() => void) | undefined;
    const finished = command
      ? new Promise<void>((resolve) => {
          ended = resolve;
        })
      : undefined;
    this.#carrying.set(id, { agent, ids: notes.map(({ id }) => id), ...(ended ? { ended } : {}) });
    try {
      await this.#store.durable();
      if (command) {
        await sendOpen({
          id,
          text: `[corrallm] ${text}`,
          from: { party: 'corrallm', name: 'corrallm' },
        });
        await finished;
        await sendOpen(message);
      } else {
        // Keep a party's header and its note in the same frame; the original body stays last.
        const split =
          message.from !== undefined && message.text.startsWith('[corrallm]')
            ? message.text.indexOf('\n')
            : -1;
        await sendOpen({
          ...message,
          text:
            split < 0
              ? `[corrallm] ${text}\n\n${message.text}`
              : `${message.text.slice(0, split)}\n${text}\n\n${message.text.slice(split + 1)}`,
        });
      }
    } catch (error) {
      this.#carrying.delete(id);
      throw error;
    }
  }

  /** A session echoed a note's carrier, or ended before it could: only an echo tells the note. */
  receive(agent: string, event: SessionEvent): void {
    if (event.type === 'user') {
      const carrying = this.#carrying.get(event.id);
      if (carrying?.agent !== agent) return;
      this.#store.toldWithdrawals(carrying.ids);
      if (!carrying.ended) this.#carrying.delete(event.id);
    } else if (event.type === 'end' || event.type === 'closed') {
      const ids = event.type === 'end' ? event.messages : [...this.#carrying.keys()];
      for (const id of ids) {
        const carrying = this.#carrying.get(id);
        if (carrying?.agent !== agent) continue;
        this.#carrying.delete(id);
        carrying.ended?.();
      }
    }
  }
}
