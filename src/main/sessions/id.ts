/** Session ids from either CLI are UUIDs: never paths, labels or command-line options. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
