import { MAX_ROLE_LENGTH } from './session';

/** Authored role text shared by files, startup IPC and the settings panel; blanks clear it. */
export function parseRole(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('The role must be text.');
  if (value.length > MAX_ROLE_LENGTH) {
    throw new RangeError(`The role must be at most ${String(MAX_ROLE_LENGTH)} characters.`);
  }
  if (!value.isWellFormed()) {
    throw new TypeError('The role must not hold a broken character (a lone surrogate).');
  }
  if (/\p{Cc}/u.test(value.replace(/[\t\n\r]/g, ''))) {
    throw new TypeError(
      'The role must not contain control characters other than tabs and line breaks.',
    );
  }
  return value.trim() || undefined;
}
