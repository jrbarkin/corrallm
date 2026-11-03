// Opt-in native readings and replies for fallback journeys; no default turn changes.
export function fallbackTurn(script, prompt, now) {
  if (!script) return null;
  if (
    script.handoff !== undefined &&
    prompt.includes('corrallm asks you to write your handoff now')
  )
    return { reply: script.handoff };
  const found = Object.entries(script.turns ?? {}).find(([marker]) => prompt.includes(marker));
  if (!found) return null;
  const turn = structuredClone(found[1]);
  if (turn.resetAfterSeconds !== undefined) {
    for (const limit of Object.values(turn.reading?.rate_limits ?? {}))
      limit.resets_at = Math.floor(now / 1000) + turn.resetAfterSeconds;
  }
  return turn;
}
