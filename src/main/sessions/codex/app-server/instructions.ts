import { property } from '../../transcript';

/** Reads current native settings, never instructions saved with an earlier conversation. */
export async function readDeveloperInstructions(
  server: { request(method: string, params: unknown): Promise<unknown> },
  cwd: string,
): Promise<string | undefined> {
  const config = property(await server.request('config/read', { cwd }), 'config');
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('Codex did not return its current developer instructions.');
  }
  const instructions = property(config, 'developer_instructions');
  if (instructions === undefined || instructions === null) return undefined;
  if (typeof instructions !== 'string') {
    throw new Error('Codex returned invalid developer instructions.');
  }
  return instructions;
}

/** An explicit empty string requests the native default, without an added role. */
export function appendRole(native: string | undefined, role: string | undefined): string {
  return role === undefined ? (native ?? '') : native ? `${native}\n\n${role}` : role;
}
