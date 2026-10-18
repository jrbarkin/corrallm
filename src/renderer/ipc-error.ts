/** Why a call to main failed, without what IPC adds to a rejection's message. */
export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

/** A call to main, rejecting with main's own words (without what IPC adds to them). */
export function fromMain<T>(call: Promise<T>): Promise<T> {
  return call.catch((error: unknown) => {
    throw new Error(ipcErrorMessage(error));
  });
}
