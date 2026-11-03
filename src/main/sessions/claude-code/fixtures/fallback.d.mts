export interface Turn {
  reply?: string;
  fail?: boolean;
  ask?: boolean;
  reading?: Record<string, unknown>;
  resetAfterSeconds?: number;
  gate?: string;
}
export interface Script {
  handoff?: string;
  turns?: Record<string, Turn>;
}
export function fallbackTurn(script: Script | undefined, prompt: string, now: number): Turn | null;
