// Shared plumbing for every chat route file.
//
// Three route modules serve team chat — the conversation itself, the realtime
// stream, and the organization furniture around it — and all three need the
// same four things: resolve the caller, check their membership, get an
// executor for their organization's database, and be able to turn a member id
// into a name. Writing that four times is how they drift.
//
// The other thing centralised here is `emit`. Publishing a change is two steps
// that must happen in one order: append to the log, then fan out. Doing it the
// other way round leaves a window in which a client reconnecting is told
// nothing happened, and no amount of care at the call site fixes that if the
// call site is free to choose the order.

import type { Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  personLabel,
  type ChatStreamEvent,
  type OrgMember,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import type { SqlExecutor } from '../storage/sql.js';
import type { WebPushService } from '../services/web-push.js';
import type { ChatRealtimeHub } from '../services/chat-realtime.js';
import type { RateLimiter } from '../services/rate-limit.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import { appendChatEvent, type AppendChatEventInput } from '../workspace-data/chat-events.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrgMembers,
} from '../workspace-data/tenancy.js';
import type { ResolveMemberName } from '../workspace-data/chat.js';

export type ChatRequest = ExpressRequest<Record<string, string>>;

export const chatParam = (req: ChatRequest, name: string): string => req.params[name] ?? '';

export interface ChatRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  webPush: WebPushService;
  hub: ChatRealtimeHub;
  limiter: RateLimiter;
}

export interface ChatScope {
  orgId: string;
  member: OrgMember;
  db: SqlExecutor;
  /** True for owners and admins. Read once here so the data layer never has to
   * know what an organization role is. */
  isAdmin: boolean;
  resolveMemberName: ResolveMemberName;
  /** Load the directory's member names, once per request. Called only by
   * routes that render people, so a mark-read call does not pay for it. */
  withNames(): Promise<ResolveMemberName>;
  /** The organization's member rows, once per request. */
  people(): Promise<OrgMember[]>;
}

/** Translate a data-layer error into the HTTP shape the rest of the API uses.
 * Anything unrecognised is a 500 rather than a guess. */
export function sendChatError(res: Response, err: unknown): void {
  if (err instanceof WorkspaceDataError) {
    sendApiError(
      res,
      err.status,
      createApiError(err.code, err.message, err.details === undefined ? {} : { details: err.details }),
    );
    return;
  }
  sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as any)?.message ?? err)));
}

/** Wrap an async handler so a thrown `WorkspaceDataError` becomes its status
 * rather than an unhandled rejection. */
export const chatHandler =
  (fn: (req: ChatRequest, res: Response) => void | Promise<void>) =>
  async (req: ChatRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendChatError(res, err);
    }
  };

export interface ChatContext {
  services: ChatRouteServices;
  directory(): SqlExecutor;
  scope(req: ChatRequest, minimum?: 'member' | 'admin' | 'owner'): Promise<ChatScope>;
  /** Append a durable event and fan it out, in that order. */
  emit(orgId: string, event: ChatStreamEvent, input?: AppendChatEventInput): Promise<void>;
  /** Same, but for callers that must not await — a message must land in the
   * channel even if telling everybody about it fails. */
  emitSoon(orgId: string, event: ChatStreamEvent, input?: AppendChatEventInput): void;
  /** Spend a rate-limit token, answering the request with 429 when the bucket
   * is empty. Returns false when the caller should stop. */
  allow(res: Response, action: string, subject: string): boolean;
}

export function createChatContext(services: ChatRouteServices): ChatContext {
  const { manager, identity, hub, limiter } = services;
  const directory = () => manager.directoryExecutor;

  async function scope(
    req: ChatRequest,
    minimum: 'member' | 'admin' | 'owner' = 'member',
  ): Promise<ChatScope> {
    const orgId = chatParam(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );

    let roster: OrgMember[] | null = null;
    let names: Map<string, string> | null = null;
    const resolveMemberName: ResolveMemberName = (memberId) => names?.get(memberId) ?? null;

    async function people(): Promise<OrgMember[]> {
      if (!roster) roster = await listOrgMembers(directory(), orgId);
      return roster;
    }

    return {
      orgId,
      member,
      db: manager.workspaceExecutor(orgId),
      isAdmin: member.role === 'owner' || member.role === 'admin',
      resolveMemberName,
      people,
      async withNames() {
        if (!names) {
          names = new Map(
            (await people()).map((row) => [
              row.id,
              personLabel({
                displayName: row.displayName,
                username: row.username,
                email: row.email,
              }),
            ]),
          );
        }
        return resolveMemberName;
      },
    };
  }

  async function emit(
    orgId: string,
    event: ChatStreamEvent,
    input: AppendChatEventInput = {},
  ): Promise<void> {
    const db = manager.workspaceExecutor(orgId);
    const stored = await appendChatEvent(db, orgId, event, input);
    hub.publish(orgId, stored);
    // Membership and visibility changes make every cached "what can this member
    // see" answer suspect. Dropping them costs one query on the next event and
    // is the difference between a private channel being invisible and being
    // invisible for up to fifteen seconds.
    if (
      event.type === 'member-joined'
      || event.type === 'member-left'
      || event.type === 'channel-created'
      || event.type === 'channel-updated'
      || event.type === 'channel-archived'
    ) {
      hub.invalidateVisibility(orgId);
    }
  }

  function emitSoon(orgId: string, event: ChatStreamEvent, input: AppendChatEventInput = {}): void {
    void emit(orgId, event, input).catch(() => {
      // Telling people is best-effort. The write already happened, and a
      // client that misses the event still gets it on its next reconnect —
      // which is exactly what the log is for.
    });
  }

  function allow(res: Response, action: string, subject: string): boolean {
    const verdict = limiter.take(action, subject);
    if (verdict.allowed) return true;
    res.setHeader('Retry-After', String(verdict.retryAfter));
    sendApiError(
      res,
      429,
      createApiError('RATE_LIMITED', 'slow down a moment', {
        details: { retryAfter: verdict.retryAfter },
      }),
    );
    return false;
  }

  return { services, directory, scope, emit, emitSoon, allow };
}
