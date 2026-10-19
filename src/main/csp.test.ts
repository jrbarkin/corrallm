import { expect, it } from 'vitest';

import { DEV_CSP, PROD_CSP } from './csp';

const sources = (policy: string, directive: string) =>
  policy
    .split('; ')
    .find((part) => part.startsWith(`${directive} `))
    ?.split(' ')
    .slice(1);

it.each([
  ['production', PROD_CSP],
  ['development', DEV_CSP],
])('allows adapter logos as data images in %s', (_name, policy) => {
  expect(sources(policy, 'img-src')).toEqual(["'self'", 'data:']);
});

it('keeps production scripts and styles free of inline and eval allowances', () => {
  expect(sources(PROD_CSP, 'script-src')).toEqual(["'self'"]);
  const styles = sources(PROD_CSP, 'style-src');
  expect(styles).toContain("'self'");
  expect(styles?.slice(1)).toHaveLength(2);
  for (const source of styles?.slice(1) ?? []) expect(source).toMatch(/^'sha256-[^']+'$/);
  expect(PROD_CSP).not.toContain("'unsafe-inline'");
  expect(PROD_CSP).not.toContain("'unsafe-eval'");
});
