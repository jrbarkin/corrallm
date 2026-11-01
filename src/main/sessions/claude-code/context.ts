/** A native token count, with no coercion or fractional tokens. */
export function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Claude Code's default compaction point when it reports no explicit threshold. */
export function compactAt(window: number, maxOutputTokens: unknown): number {
  const output = tokenCount(maxOutputTokens) ? Math.min(maxOutputTokens, 20_000) : 20_000;
  return Math.max(0, window - output - 13_000);
}
