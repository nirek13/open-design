// Organization, membership, invite, and app-sharing HTTP surface.
//
// Route families:
//   GET  /api/auth/context          unauthenticated bootstrap for the client
//   /api/orgs/*                     organizations, members, invites
//   /api/orgs/:orgId/apps/*         publishing and sharing apps
//   POST /api/invites/:token/accept  redeem an invite (needs a viewer)
//   GET  /api/invites/:token         unauthenticated invite preview
//   GET  /s/:token(/*)              unauthenticated shared-app viewer
//
// Every authenticated route resolves the caller once (`viewerFor`) and then
// checks membership in the target organization. In local-owner mode the
// caller is always the machine owner, so these checks are inert but still
// exercised — the same code path serves both modes.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  ORG_HEADER,
  createApiError,
  type CreateOrgInviteRequest,
  type CreateOrganizationRequest,
  type OrgRole,
  type PublishAppRequest,
  type UpdateAppRequest,
  type UpdateOrgMemberRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService, Viewer } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  acceptOrgInvite,
  assertMemberRole,
  createOrgInvite,
  createOrganization,
  getActiveMemberForUser,
  getOrgMember,
  getOrganization,
  listOrgInvites,
  listOrgMembers,
  listOrganizationsForUser,
  lookupInviteByToken,
  renameOrganization,
  revokeOrgInvite,
  updateOrgMember,
} from '../workspace-data/tenancy.js';
import {
  createAppShareLink,
  getApp,
  listAppShareLinks,
  listApps,
  publishApp,
  recordAppOpen,
  recordShareView,
  resolveShareRoute,
  resolveShareToken,
  revokeAppShareLink,
  updateApp,
} from '../workspace-data/apps.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface OrganizationRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  /** Serves an app's HTML file for the public share viewer. */
  serveAppFile: (
    req: Request,
    res: Response,
    input: { projectId: string; filePath: string },
  ) => Promise<void>;
}

export interface RegisterOrganizationRoutesDeps extends RouteDeps<'db'> {
  organizations: OrganizationRouteServices;
}

export function registerOrganizationRoutes(app: Express, ctx: RegisterOrganizationRoutesDeps) {
  const { manager, identity, serveAppFile } = ctx.organizations;
  const directory = () => manager.directoryExecutor;

  function fail(res: Response, err: unknown): void {
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

  const handle =
    (fn: (req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  async function viewerFor(req: Request): Promise<Viewer> {
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) {
      throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    }
    return viewer;
  }

  /** Resolve the organization a request acts in and the caller's standing in
   * it, refusing anything below `minimum`. The org comes from the route param
   * when present, else the `x-od-org` header, else the caller's first org. */
  async function scope(req: Request, minimum: OrgRole = 'member') {
    const viewer = await viewerFor(req);
    const explicit = param(req, 'orgId') || req.get(ORG_HEADER) || '';
    const orgId =
      explicit || (await listOrganizationsForUser(directory(), viewer.userId))[0]?.id || '';
    if (!orgId) {
      throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'you do not belong to any organization yet');
    }
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    return { viewer, orgId, member, db: manager.workspaceExecutor(orgId) };
  }

  async function memberNameResolver(orgId: string): Promise<(memberId: string) => string | null> {
    const members = await listOrgMembers(directory(), orgId);
    const byId = new Map(members.map((member) => [member.id, member.displayName]));
    return (memberId: string) => byId.get(memberId) ?? null;
  }

  /** Base URL for links a human will paste into a browser.
   *
   * Invite and share links are useless if they point somewhere the recipient
   * cannot reach, so they honor `OD_PUBLIC_BASE_URL` — the same env var the
   * OAuth callback URL uses — before falling back to the request's own host.
   * That fallback is right for the packaged app (one origin serves both the
   * API and the SPA) but wrong behind a reverse proxy or a split dev setup,
   * which is exactly what the env var is for. */
  function publicBaseUrl(req: Request): string {
    const configured = process.env.OD_PUBLIC_BASE_URL;
    if (configured && /^https?:\/\//i.test(configured)) {
      return configured.replace(/\/+$/u, '');
    }
    const host = req.get('host') ?? '127.0.0.1';
    return `${req.protocol || 'http'}://${host}`;
  }

  const shareUrlFor = (req: Request, token: string) => `${publicBaseUrl(req)}/s/${token}`;
  const joinUrlFor = (req: Request, token: string) => `${publicBaseUrl(req)}/join/${token}`;

  // --- Bootstrap ----------------------------------------------------------

  // Unauthenticated on purpose: the client cannot know whether to render a
  // sign-in screen until it has read this.
  app.get('/api/auth/context', handle(async (req, res) => {
    const viewer = await identity.resolveViewer(req, directory());
    res.json({
      mode: identity.config.mode,
      ...(identity.config.publishableKey ? { publishableKey: identity.config.publishableKey } : {}),
      viewer: viewer
        ? { userId: viewer.userId, displayName: viewer.displayName, email: viewer.email }
        : null,
      organizations: viewer ? await listOrganizationsForUser(directory(), viewer.userId) : [],
    });
  }));

  // --- Organizations ------------------------------------------------------

  app.get('/api/orgs', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    res.json({ organizations: await listOrganizationsForUser(directory(), viewer.userId) });
  }));

  app.post('/api/orgs', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const body = (req.body ?? {}) as CreateOrganizationRequest;
    const organization = await createOrganization(directory(), {
      name: typeof body.name === 'string' ? body.name : '',
      ownerUserId: viewer.userId,
    });
    manager.workspaceExecutor(organization.id);
    res.status(201).json({ organization });
  }));

  app.get('/api/orgs/:orgId', handle(async (req, res) => {
    const { orgId } = await scope(req);
    res.json({ organization: await getOrganization(directory(), orgId) });
  }));

  app.patch('/api/orgs/:orgId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    res.json({ organization: await renameOrganization(directory(), orgId, name) });
  }));

  // --- Members ------------------------------------------------------------

  app.get('/api/orgs/:orgId/members', handle(async (req, res) => {
    const { orgId } = await scope(req);
    res.json({ members: await listOrgMembers(directory(), orgId) });
  }));

  app.patch('/api/orgs/:orgId/members/:memberId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'owner');
    const body = (req.body ?? {}) as UpdateOrgMemberRequest;
    const patch: { role?: OrgRole; status?: 'active' | 'removed' } = {};
    if (body.role !== undefined) patch.role = body.role;
    if (body.status !== undefined) patch.status = body.status;
    res.json({ member: await updateOrgMember(directory(), orgId, param(req, 'memberId'), patch) });
  }));

  app.delete('/api/orgs/:orgId/members/:memberId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'owner');
    await getOrgMember(directory(), orgId, param(req, 'memberId'));
    res.json({
      member: await updateOrgMember(directory(), orgId, param(req, 'memberId'), { status: 'removed' }),
    });
  }));

  // --- Invites ------------------------------------------------------------

  app.get('/api/orgs/:orgId/invites', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    res.json({ invites: await listOrgInvites(directory(), orgId) });
  }));

  app.post('/api/orgs/:orgId/invites', handle(async (req, res) => {
    const { orgId, member } = await scope(req, 'admin');
    const body = (req.body ?? {}) as CreateOrgInviteRequest;
    const created = await createOrgInvite(directory(), orgId, member.id, body);
    // The token is returned exactly here and never again; only its hash is
    // stored, so a lost link must be re-issued rather than recovered.
    res.status(201).json({
      invite: created.invite,
      token: created.token,
      url: joinUrlFor(req, created.token),
    });
  }));

  app.post('/api/orgs/:orgId/invites/:inviteId/revoke', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    res.json({ invite: await revokeOrgInvite(directory(), orgId, param(req, 'inviteId')) });
  }));

  // Unauthenticated: someone following a link needs to see what they are
  // joining before deciding to sign in. Exposes the org name and role only.
  app.get('/api/invites/:token', handle(async (req, res) => {
    const lookup = await lookupInviteByToken(directory(), param(req, 'token'));
    if (!lookup.ok) {
      res.json({ valid: false, reason: lookup.reason, orgName: '', role: 'member' });
      return;
    }
    res.json({
      valid: true,
      orgName: lookup.value.org.name,
      role: lookup.value.invite.role,
    });
  }));

  app.post('/api/invites/:token/accept', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const accepted = await acceptOrgInvite(directory(), param(req, 'token'), viewer.userId);
    manager.workspaceExecutor(accepted.organization.id);
    res.json({ organization: accepted.organization, member: accepted.member });
  }));

  // --- Apps ---------------------------------------------------------------

  app.get('/api/orgs/:orgId/apps', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({
      apps: await listApps(db, orgId, {
        includeArchived: req.query.includeArchived === '1',
        viewerMemberId: member.id,
        resolveMemberName: await memberNameResolver(orgId),
      }),
    });
  }));

  app.post('/api/orgs/:orgId/apps', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const body = (req.body ?? {}) as PublishAppRequest;
    res.status(201).json({ app: await publishApp(db, orgId, member.id, member.displayName, body) });
  }));

  app.get('/api/orgs/:orgId/apps/:appId', handle(async (req, res) => {
    const { orgId, db } = await scope(req);
    const resolve = await memberNameResolver(orgId);
    const found = await getApp(db, orgId, param(req, 'appId'));
    res.json({ app: { ...found, createdByName: resolve(found.createdBy) } });
  }));

  app.patch('/api/orgs/:orgId/apps/:appId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const existing = await getApp(db, orgId, param(req, 'appId'));
    // Anyone can adjust an app they published; changing someone else's is an
    // administrative act.
    if (existing.createdBy !== member.id) await scope(req, 'admin');
    res.json({ app: await updateApp(db, orgId, param(req, 'appId'), (req.body ?? {}) as UpdateAppRequest) });
  }));

  app.post('/api/orgs/:orgId/apps/:appId/open', handle(async (req, res) => {
    const { orgId, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await recordAppOpen(db, found.id);
    res.json({ app: await getApp(db, orgId, found.id) });
  }));

  app.get('/api/orgs/:orgId/apps/:appId/shares', handle(async (req, res) => {
    const { orgId, db } = await scope(req);
    res.json({ shares: await listAppShareLinks(db, orgId, param(req, 'appId')) });
  }));

  app.post('/api/orgs/:orgId/apps/:appId/shares', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const created = await createAppShareLink(
      db,
      directory(),
      orgId,
      param(req, 'appId'),
      member.id,
      req.body ?? {},
    );
    res.status(201).json({
      share: created.share,
      token: created.token,
      url: shareUrlFor(req, created.token),
    });
  }));

  app.post('/api/orgs/:orgId/apps/:appId/shares/:shareId/revoke', handle(async (req, res) => {
    const { orgId, db } = await scope(req);
    res.json({
      share: await revokeAppShareLink(db, directory(), orgId, param(req, 'appId'), param(req, 'shareId')),
    });
  }));

  // --- Public shared-app viewer -------------------------------------------

  // Deliberately outside /api and without any auth: the unguessable token is
  // the entire credential. Registered before the SPA fallback so it wins.
  //
  // Link-shared apps are served through the locked-down preview headers,
  // which set `connect-src 'none'`. That is the security line: an anonymous
  // viewer gets the interface, never a channel into organization data.
  app.get('/s/:token', handle(async (req, res) => {
    const token = param(req, 'token');
    const route = await resolveShareRoute(directory(), token);
    if (!route) {
      throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'this share link is not valid');
    }
    const db = manager.workspaceExecutor(route.orgId);
    const { app: sharedApp, share } = await resolveShareToken(db, route.orgId, token);
    await recordShareView(db, share.id);
    await recordAppOpen(db, sharedApp.id);
    await serveAppFile(req, res, {
      projectId: sharedApp.projectId,
      filePath: sharedApp.filePath,
    });
  }));
  app.get(/^\/s\/([^/]+)\/(.+)$/u, handle(async (req, res) => {
    // Relative asset requests from inside a shared page (images, css) resolve
    // against the same project as the entry file.
    const positional = req.params as unknown as { 0?: string; 1?: string };
    const token = positional[0] ?? '';
    const relPath = positional[1] ?? '';
    const route = await resolveShareRoute(directory(), token);
    if (!route) {
      throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'this share link is not valid');
    }
    const db = manager.workspaceExecutor(route.orgId);
    const { app: sharedApp } = await resolveShareToken(db, route.orgId, token);
    await serveAppFile(req, res, { projectId: sharedApp.projectId, filePath: relPath });
  }));
}
