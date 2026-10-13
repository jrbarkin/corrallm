import { useEffect, useState } from 'react';

/*
 * The Option key in a Terminal agent's terminal, on macOS. Claude Code's Option shortcuts (as
 * Option+P, its model picker) need Option to work as Meta; but on many keyboard layouts Option
 * types characters people need (@ on a German or French one). So Option is Meta by default only on
 * a layout like the US one, whose Option characters are rare symbols; the user can choose
 * otherwise, and their choice is kept for them (in this app's storage, on this computer).
 */

/** What each key of the US layout types, unshifted, by where it is on the keyboard. */
const US_KEYS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from('abcdefghijklmnopqrstuvwxyz', (letter) => [`Key${letter.toUpperCase()}`, letter]),
  ),
  ...Object.fromEntries(Array.from('0123456789', (digit) => [`Digit${digit}`, digit])),
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * Whether a keyboard layout (what each key types, by its code, as the Keyboard API's layout map
 * gives it) is like the US one: every letter, digit and punctuation key types what it does there.
 */
export function isUsLike(layout: ReadonlyMap<string, string>): boolean {
  return Object.entries(US_KEYS).every(([code, key]) => layout.get(code) === key);
}

/** The Keyboard API, where the browser has it (Chromium does, in a secure page). */
interface KeyboardApi {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

/** Whether Option should be Meta by default: only if the keyboard's layout is US-like. */
export async function optionIsMetaByDefault(
  keyboard = (navigator as { keyboard?: KeyboardApi }).keyboard,
): Promise<boolean> {
  try {
    const layout = await keyboard?.getLayoutMap?.();
    return layout !== undefined && isUsLike(layout);
  } catch {
    // No layout to go by: Option types characters, as most terminals have it.
    return false;
  }
}

const SETTING = 'corrallm.terminal.optionIsMeta';

/** The user's choice, if they made one. */
export function savedOptionIsMeta(): boolean | undefined {
  try {
    const saved = localStorage.getItem(SETTING);
    return saved === 'on' ? true : saved === 'off' ? false : undefined;
  } catch {
    return undefined;
  }
}

function saveOptionIsMeta(on: boolean): void {
  try {
    localStorage.setItem(SETTING, on ? 'on' : 'off');
  } catch {
    // Not kept: it holds while the view is open.
  }
}

/** Whether this is a Mac, where Option is a key of its own (elsewhere Alt is Meta anyway). */
export function isMac(): boolean {
  return navigator.platform.startsWith('Mac');
}

/**
 * Whether Option works as Meta in terminals: the user's choice, or else what their keyboard's
 * layout suggests; and a function to choose (kept for next time).
 */
export function useOptionIsMeta(): [boolean, (on: boolean) => void] {
  const [chosen, setChosen] = useState(savedOptionIsMeta);
  const [suggested, setSuggested] = useState(false);
  useEffect(() => {
    if (chosen !== undefined) return;
    let gone = false;
    void optionIsMetaByDefault().then((on) => {
      if (!gone) setSuggested(on);
    });
    return () => {
      gone = true;
    };
  }, [chosen]);
  return [
    chosen ?? suggested,
    (on) => {
      saveOptionIsMeta(on);
      setChosen(on);
    },
  ];
}
