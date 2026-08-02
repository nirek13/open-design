import type { OrgActorKind } from '@open-design/contracts';

/** Identity attached to every write at the chokepoint. Interactive requests
 * resolve to a member; agent runs carry run/project ids from the tool-token
 * grant; public-form submissions carry the form-link id as actor id. */
export interface WorkspaceActor {
  kind: OrgActorKind;
  /** Member id when kind is 'user'. */
  memberId?: string | null;
  /** Registered tool id when the write came through a generated tool. */
  toolId?: string | null;
  runId?: string | null;
  projectId?: string | null;
}
