// Opt-in native account readings for the App Server's fallback journeys.
export function fallbackTurn(script, prompt, now) {
  const found = Object.entries(script?.turns ?? {}).find(([marker]) => prompt.includes(marker));
  if (!found) return null;
  const turn = structuredClone(found[1]);
  if (turn.usedPercent !== undefined)
    turn.limits = {
      limitId: 'codex',
      limitName: null,
      primary: {
        usedPercent: turn.usedPercent,
        windowDurationMins: 300,
        resetsAt: Math.floor(now / 1000) + (turn.resetAfterSeconds ?? 3600),
      },
      secondary: null,
      credits: null,
      planType: 'plus',
      rateLimitReachedType: null,
    };
  return turn;
}
