/** Why a call to main failed, without what IPC adds to a rejection's message. */
export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
