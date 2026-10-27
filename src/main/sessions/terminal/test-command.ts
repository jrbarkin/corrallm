import { appendFileSync } from 'node:fs';

import type { HookEvent, HookRegistration } from './hooks';
import { HookServer } from './hooks';
import type { Pty } from './pty';
import { Command } from '../test-kill';

/** In-memory hook transport; the real HTTP transport has its own tests. */
export class CommandHooks extends HookServer {
  #hear: ((event: HookEvent) => void) | undefined;
  override register(listener: (event: HookEvent) => void): Promise<HookRegistration> {
    this.#hear = listener;
    return Promise.resolve({
      url: 'http://127.0.0.1:1/hook',
      statusUrl: 'http://127.0.0.1:1/status',
      token: 'test',
      release: () => {
        this.#hear = undefined;
      },
    });
  }
  emit(name: string, fields: Record<string, unknown> = {}): void {
    this.#hear?.({ hook_event_name: name, ...fields });
  }
}

/** A native terminal fake: Escape stops this turn's real command before reporting idle. */
export class CommandPty implements Pty {
  readonly pid = 4242;
  readonly commands: Command[] = [];
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { exitCode: number }) => void>();
  readonly #draw: (draft: string, state: 'idle' | 'working' | 'done') => string;
  readonly #hooks: CommandHooks;
  readonly #log: string;
  #draft = '';
  #current: Command | undefined;
  #state: 'idle' | 'working' | 'done' = 'idle';
  #closed = false;
  constructor(
    log: string,
    hooks: CommandHooks,
    draw: (draft: string, state: 'idle' | 'working' | 'done') => string,
  ) {
    this.#log = log;
    this.#hooks = hooks;
    this.#draw = draw;
    setTimeout(() => {
      this.#print();
    }, 0);
  }
  onData(listener: (data: string) => void): void {
    this.#data.add(listener);
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.#exit.add(listener);
  }
  resize(): void {
    this.#print();
  }
  pause(): void {
    /* Small fixture output never backpressures. */
  }
  resume(): void {
    /* Small fixture output never backpressures. */
  }
  kill(): void {
    void this.close();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(this.commands.map((command) => command.stop()));
    for (const listener of this.#exit) listener({ exitCode: 0 });
  }
  write(data: string): void {
    if (this.#closed) return;
    if (data === '\x03') {
      void this.close();
      return;
    }
    if (data === '\x1b') {
      void this.#interrupt();
      return;
    }
    if (data === '\r') {
      void this.#submit();
      return;
    }
    if (data.startsWith('\x1b[200~')) this.#draft += data.slice(6, -6);
    else if (!data.startsWith('\x1b')) this.#draft += data;
    this.#print();
  }
  #record(record: unknown): void {
    appendFileSync(this.#log, `${JSON.stringify(record)}\n`);
  }
  #print(): void {
    if (!this.#closed)
      for (const listener of this.#data) listener(this.#draw(this.#draft, this.#state));
  }
  async #submit(): Promise<void> {
    if (this.#state === 'working' || this.#draft === '') return;
    const text = this.#draft;
    this.#draft = '';
    this.#record({
      type: 'turn',
      live: this.commands.filter((command) => command.alive).map((command) => command.child.pid),
    });
    this.#hooks.emit('UserPromptSubmit', { prompt: text });
    this.#state = 'working';
    this.#print();
    if (text.includes('command')) {
      const command = new Command();
      this.commands.push(command);
      await command.ready;
      this.#record({ type: 'process', pid: command.child.pid });
      if (!text.startsWith('background')) this.#current = command;
    }
    if (text.startsWith('slow')) return;
    this.#hooks.emit('Stop', { last_assistant_message: 'Done' });
    this.#state = 'done';
    this.#print();
  }
  async #interrupt(): Promise<void> {
    await this.#current?.stop();
    this.#current = undefined;
    this.#hooks.emit('Interrupt');
    this.#state = 'idle';
    this.#print();
  }
}
