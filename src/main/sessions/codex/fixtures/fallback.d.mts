export interface Turn {
  fail?: boolean;
  reply?: string;
  usedPercent?: number;
  resetAfterSeconds?: number;
  gate?: string;
}
export interface Script {
  turns?: Record<string, Turn>;
}
export function fallbackTurn(
  script: Script | undefined,
  prompt: string,
  now: number,
): (Turn & { limits?: Record<string, unknown> }) | null;
