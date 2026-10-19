/*
 * Typing a message into Claude Code's prompt, as a person would. Claude Code takes input that
 * arrives all at once for a paste: a long or multi-line one collapses to "[Pasted text #1]" and
 * reaches the model wrapped as pasted content (which it is told not to take instructions from),
 * and Enter inside it is not a submit. So corrallm types: a few characters at a time, Ctrl+J for
 * each line break, then Enter on its own (the session sends it, once the text is in).
 */

/** At most this many characters in one keystroke write. */
const CHUNK = 32;
/** Ctrl+J: a new line in Claude Code's prompt, without sending it. */
export const NEW_LINE = '\n';

/**
 * `text` as plain text to type: line breaks as \n, tabs as spaces, and no control characters,
 * which would act as keys (Escape would interrupt, Ctrl+C clear the prompt or quit).
 */
export function typeable(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      // C0 controls but \n, DEL, and C1 controls.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
      .replace(/\n+$/, '')
  );
}

/** The writes that type `text` (see `typeable`): short runs of characters, and each line break alone. */
export function keystrokes(text: string): string[] {
  const writes: string[] = [];
  typeable(text)
    .split('\n')
    .forEach((line, index) => {
      if (index > 0) writes.push(NEW_LINE);
      // By code point, so that no character is split between writes.
      const characters = Array.from(line);
      for (let at = 0; at < characters.length; at += CHUNK) {
        writes.push(characters.slice(at, at + CHUNK).join(''));
      }
    });
  return writes;
}
