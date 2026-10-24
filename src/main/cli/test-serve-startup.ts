import type { Readable } from 'node:stream';

/** Discovery is published before delivery starts and the complete serving line is printed. */
export async function waitForServing<T>(
  api: Promise<T>,
  exited: Promise<number | null>,
  output: Readable,
  said: () => string,
): Promise<T> {
  const printed = Promise.withResolvers<undefined>();
  const hear = () => {
    if (/(?:^|\n)corrallm serve: serving [^\r\n]*\r?\n/.test(said())) printed.resolve(undefined);
  };
  output.on('data', hear);
  // The line might already have arrived while api.json's read was being started.
  hear();
  try {
    const [discovery] = await Promise.race([
      Promise.all([api, printed.promise]),
      exited.then((code) => {
        throw new Error(`serve exited ${String(code)} before serving: ${said()}`);
      }),
    ]);
    return discovery;
  } finally {
    output.off('data', hear);
  }
}
