import { act, fireEvent, render } from '@testing-library/react';
import type { ReactElement } from 'react';

/** A gesture completes its asynchronous operation and resulting React updates. */
type Events = {
  [K in keyof typeof fireEvent]: (...args: Parameters<(typeof fireEvent)[K]>) => Promise<void>;
};
export const events = new Proxy(fireEvent, {
  get(target, key) {
    const value: unknown = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    const method = value as (...args: unknown[]) => boolean;
    return async (...args: unknown[]) => {
      await act(() => Promise.resolve(method(...args)));
    };
  },
}) as unknown as Events;

/** Finish the initial subscription and run restore before interacting with an editor. */
export async function renderReady(element: ReactElement) {
  const view = render(element);
  await act(() => Promise.resolve());
  return view;
}
