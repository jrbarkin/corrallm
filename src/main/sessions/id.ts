/** The platform minimum before an id can reach a native CLI or its conversation files (R42a). */
export function isNativeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.startsWith('-') &&
    !/[^A-Za-z0-9._:-]/.test(value)
  );
}

/** An adapter's stricter check, always preceded by the platform minimum. */
export function requireConversationId(
  adapter: string,
  value: unknown,
  shape: (value: string) => boolean,
): asserts value is string {
  if (!isNativeId(value) || !shape(value))
    throw new TypeError(`Invalid ${adapter} conversation id.`);
}

/** A UUID shape an adapter may declare. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
