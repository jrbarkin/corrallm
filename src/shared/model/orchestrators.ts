import { z } from 'zod';
import { OrchestratorId } from '../api/ids';

const Path = z.string().min(1).max(4096);
export const ApprovedOrchestrator = z.strictObject({
  id: z.uuid(),
  folder: Path,
  canvas: z.uuid(),
  withoutApprovals: z.boolean(),
  created: z.int().nonnegative(),
  lastUsed: z.int().nonnegative(),
});
export const OrchestratorRequest = z.strictObject({
  id: z.uuid(),
  folder: Path,
  into: Path,
  requester: z.literal('an agent'),
  expires: z.int().nonnegative(),
});
export const OrchestratorsView = z.strictObject({
  approved: z.array(ApprovedOrchestrator).max(128),
  pending: z.array(OrchestratorRequest).max(8),
});
export type OrchestratorsView = z.infer<typeof OrchestratorsView>;
export const OrchestratorIntent = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('allow'), id: OrchestratorId, withoutApprovals: z.boolean() }),
  z.strictObject({ action: z.enum(['decline', 'revoke']), id: OrchestratorId }),
]);

export const OPEN_APP = 'Open the corrallm app to approve this orchestrator request.';

export type OrchestratorIntent = z.infer<typeof OrchestratorIntent>;
