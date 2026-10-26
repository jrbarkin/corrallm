import type { SessionSpec } from './connector';

/** A resource bound for C's already-authorized, escaped startup context; never a message. */
export const MAX_WORKSPACE_CONTEXT_BYTES = 8192;

/**
 * Adapter consumer seam only. C must supply the authorized projection and invalidate stale
 * context/conversation generations before composing it; the manager supplies none until then.
 * The saved role stays separate. Native instructions are appended, never a user/shell turn.
 */
export function launchInstructions(
  spec: Pick<SessionSpec, 'role' | 'workspaceContext'>,
): string | undefined {
  const context = spec.workspaceContext?.trim();
  if (!context) return spec.role;
  if (Buffer.byteLength(context, 'utf8') > MAX_WORKSPACE_CONTEXT_BYTES)
    throw new Error('The workspace context exceeds 8 KiB.');
  return [spec.role, `[corrallm workspace context]\n${context}`].filter(Boolean).join('\n\n');
}
