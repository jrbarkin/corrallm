/**
 * Messages for the Agent SDK to read as they come: the prompt of a streaming query, which keeps
 * the session (and its CLI) running between turns. `push` hands one over; `end` ends the session's
 * input, after which the CLI exits.
 */
export class Inbox<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  #ended = false;

  push(item: T): void {
    if (this.#ended) throw new Error('The session has ended.');
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  end(): void {
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
