import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only registers its own cleanup when test globals are enabled; they are not.
afterEach(() => {
  cleanup();
});
