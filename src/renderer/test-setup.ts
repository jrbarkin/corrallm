import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its own cleanup when test globals are enabled; they are not.
afterEach(() => {
  cleanup();
});

// jsdom lacks the layout APIs React Flow measures nodes with
// (https://reactflow.dev/learn/advanced-use/testing). The observer reports each element as soon as
// it is observed, and elements measure as their inline width/height (1px when unset), so nodes get
// dimensions and handle bounds and render visibly.
class ResizeObserverStub {
  readonly #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element) {
    const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry;
    this.#callback([entry], this);
  }
  unobserve() {
    // Nothing to release.
  }
  disconnect() {
    // Nothing to release.
  }
}

class DOMMatrixReadOnlyStub {
  readonly m22 = 1;
}

Object.defineProperties(globalThis, {
  ResizeObserver: { value: ResizeObserverStub, configurable: true },
  DOMMatrixReadOnly: { value: DOMMatrixReadOnlyStub, configurable: true },
});
Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: {
    get(this: HTMLElement) {
      return parseFloat(this.style.width) || 1;
    },
  },
  offsetHeight: {
    get(this: HTMLElement) {
      return parseFloat(this.style.height) || 1;
    },
  },
});
