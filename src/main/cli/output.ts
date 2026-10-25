/**
 * A line as the terminal is given it: each control character (C0, DEL, C1) shown as its escape
 * (`\x1b`), so no name, title or path it quotes can move the cursor, erase what was said, ring,
 * or set the clipboard.
 */
export function shown(line: string): string {
  return line.replace(
    /\p{Cc}/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

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
