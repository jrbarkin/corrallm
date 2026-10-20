/** A command's output stream, and whether its destination is a terminal. */
export interface Output {
  isTTY?: boolean;
  write(text: string, written: () => void): unknown;
}

/** Waits for output to drain; a terminal that hung up gets at most a second. */
export function writtenOut(streams: readonly Output[]): Promise<void> {
  return Promise.all(
    streams.map(
      (stream) =>
        new Promise<void>((resolve) => {
          const timer = stream.isTTY ? setTimeout(resolve, 1000) : undefined;
          stream.write('', () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  ).then(() => undefined);
}
