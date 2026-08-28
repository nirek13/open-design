// Organization, membership, invite, and app-sharing HTTP surface.
//
// Route families:
//   GET  /api/auth/context          unauthenticated bootstrap for the client
//   /api/orgs/*                     organizations, members, invites
//   /api/orgs/:orgId/apps/*         publishing and sharing apps
//   GET  /api/me/invites            targeted invites waiting on the caller
//   POST /api/me/invites/:id/accept redeem a targeted invite without the token
//   POST /api/invites/:token/accept  redeem an invite (needs a viewer)
//   GET  /api/invites/:token         unauthenticated invite preview
//   GET  /s/:token(/*)              unauthenticated shared-app viewer
//
// Every authenticated route resolves the caller once (`viewerFor`) and then
// checks membership in the target organization. In local-owner mode the
// caller is always the machine owner, so these checks are inert but still
// exercised — the same code path serves both modes.

import type { Express, Request as ExpressRequest, Response } from 'express';
import multer from 'multer';
import {
  ORG_HEADER,
  appRequestsTableWrites,
  createApiError,
  type CreateOrgInviteRequest,
  type CreateOrganizationRequest,
  type CreateOrgTeamRequest,
  type OrgApp,
  type OrgRole,
  type PublishAppRequest,
  type SetAppGrantsRequest,
  type UpdateAppRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgMemberRequest,
  type UpdateOrgTeamRequest,
  type UpdateProfileRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService, Viewer } from '../auth/identity.js';
import type { ConnectorService } from '../connectors/service.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import type { WorkspaceDataEvents } from '../workspace-data/events.js';
import {
  PUBLIC_APP_HOST_CSP,
  allowPublicIngest,
  handlePublicAppBridge,
  renderPublicAppHost,
  setPublicIngestCors,
} from '../workspace-data/public-app-host.js';
import {
  acceptOrgInvite,
  acceptPendingInvite,
  assertMemberRole,
  createOrgInvite,
  createOrganization,
  createOrgTeam,
  deleteOrgTeam,
  getActiveMemberForUser,
  getOrgMember,
  getOrgTeam,
  getOrganization,
  getUser,
  getUserByUsername,
  listOrgInvites,
  listOrgMembers,
  listOrgTeams,
  listOrganizationsForUser,
  listPendingInvitesForUser,
  listTeamIdsForMember,
  lookupInviteByToken,
  renameOrganization,
  updateOrganization,
  revokeOrgInvite,
  setUserAvatarMime,
  setUserUsername,
  updateOrgMember,
  updateOrgTeam,
  updateUserProfile,
  profileAvatarUrl,
  type DirectoryUser,
} from '../workspace-data/tenancy.js';
import {
  createAppShareLink,
  deleteAppTeamGrants,
  getApp,
  listAppAccess,
  listAppShareLinks,
  listApps,
  publishApp,
  publishAppToWeb,
  recordAppOpen,
  recordShareView,
  resolveShareRoute,
  resolveShareToken,
  revokeAppShareLink,
  setAppGrants,
  updateApp,
  assertCanEditApp,
  assertCanViewApp,
} from '../workspace-data/apps.js';
import {
  composeOrgInviteEmail,
  createGmailExecutor,
  GMAIL_CONNECTOR_ID,
  sendMail,
} from '../workspace-data/mail.js';
import { browserFacingOrigin, clerkFacingOrigin, requestOrigin } from '../origin-validation.js';
import {
  AVATAR_MAX_BYTES,
  deleteAvatarFile,
  readAvatarFile,
  writeAvatarFile,
} from '../workspace-data/avatars.js';
import { resolveOrgMark } from '../workspace-data/org-mark.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface OrganizationRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  /** Daemon data root. Profile photos are stored under `{dataDir}/avatars`. */
  dataDir: string;
  /** Optional: when Gmail is connected, email invites are sent through it. */
  connectors?: ConnectorService;
  /** Serves an app's HTML file for the public share viewer. */
  serveAppFile: (
    req: Request,
    res: Response,
    input: { projectId: string; filePath: string },
  ) => Promise<void>;
  /** HTML source for wrapping a data-connected public share. */
  loadAppHtml?: (input: { projectId: string; filePath: string }) => Promise<string | null>;
  /** Live-update fan-out when a public form appends a row. */
  events?: WorkspaceDataEvents;
  /** User design-system root. Used to find the harvested logo of the default kit. */
  userDesignSystemsRoot?: string;
  /** Managed-project root. Harvested brand logos live under `{project}/logos`. */
  projectsRoot?: string;
  getProject?: (projectId: string) => { metadata?: Record<string, unknown> } | null | undefined;
  /** Injectable so tests never scrape the public internet. */
  harvestWebsiteMark?: (siteUrl: string, logosDir: string) => Promise<void>;
}

export interface RegisterOrganizationRoutesDeps extends RouteDeps<'db'> {
  organizations: OrganizationRouteServices;
}

export function registerOrganizationRoutes(app: Express, ctx: RegisterOrganizationRoutesDeps) {
  const {
    manager,
    identity,
    serveAppFile,
    loadAppHtml,
    events,
    connectors,
    dataDir,
    userDesignSystemsRoot,
    projectsRoot,
    getProject,
    harvestWebsiteMark,
  } = ctx.organizations;
  const directory = () => manager.directoryExecutor;

  function orgMarkInput(org: {
    id: string;
    websiteUrl?: string | null;
    defaultDesignSystemId?: string | null;
  }) {
    return {
      dataDir,
      org,
      userDesignSystemsRoot,
      projectsRoot,
      getProject,
      harvest: harvestWebsiteMark,
    };
  }

  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  });

  function toProfile(user: DirectoryUser) {
    return {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      username: user.username,
      bio: user.bio,
      avatarUrl: profileAvatarUrl(user.id, user.avatarMime),
    };
  }

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

  async function teamNameResolver(orgId: string): Promise<(teamId: string) => string | null> {
    const teams = await listOrgTeams(directory(), orgId);
    const byId = new Map(teams.map((team) => [team.id, team.name]));
    return (teamId: string) => byId.get(teamId) ?? null;
  }

  async function accessResolvers(orgId: string) {
    const [memberName, teamName] = await Promise.all([memberNameResolver(orgId), teamNameResolver(orgId)]);
    return { memberName, teamName };
  }

  async function appViewerFor(orgId: string, member: { id: string; role: OrgRole }) {
    return {
      memberId: member.id,
      role: member.role,
      teamIds: await listTeamIdsForMember(directory(), orgId, member.id),
    };
  }

  async function assertTeamsExist(
    orgId: string,
    teamGrants: Array<{ teamId: string }> | undefined,
  ): Promise<void> {
    if (!teamGrants?.length) return;
    for (const grant of teamGrants) {
      if (typeof grant.teamId !== 'string' || !grant.teamId.trim()) continue;
      await getOrgTeam(directory(), orgId, grant.teamId.trim());
    }
  }

  /** Origin for share links. `GET /s/:token` is served by the daemon, but
   * browsers open the public/web origin (`/s/` is proxied there in split-port
   * and reverse-proxy installs). Use the same origin join links use so a
   * rewritten loopback `Host` cannot mint `http://127.0.0.1:7456/s/…`. */
  function publicBaseUrl(req: Request): string {
    return browserFacingOrigin(req);
  }

  const shareUrlFor = (req: Request, token: string) => `${publicBaseUrl(req)}/s/${token}`;
  /** Join landing is the web SPA. In split-port local runs that is not this
   * daemon, so the URL follows `browserFacingOrigin`. */
  const joinUrlFor = (req: Request, token: string) => `${browserFacingOrigin(req)}/join/${token}`;

  // --- Bootstrap ----------------------------------------------------------

  // Unauthenticated on purpose: the client cannot know whether to render a
  // sign-in screen until it has read this.
  app.get('/api/auth/context', handle(async (req, res) => {
    const viewer = await identity.resolveViewer(req, directory());
    res.json({
      mode: identity.config.mode,
      ...(identity.config.publishableKey ? { publishableKey: identity.config.publishableKey } : {}),
      appOrigin: clerkFacingOrigin(req),
      viewer: viewer
        ? {
            userId: viewer.userId,
            displayName: viewer.displayName,
            email: viewer.email,
            username: viewer.username,
            bio: viewer.bio,
            avatarUrl: viewer.avatarUrl,
          }
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

  app.get('/api/orgs/:orgId/mark', handle(async (req, res) => {
    const { orgId } = await scope(req);
    const organization = await getOrganization(directory(), orgId);
    const mark = await resolveOrgMark(orgMarkInput(organization));
    if (!mark) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'mark not found');
    }
    res.setHeader('Content-Type', mark.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(mark.buffer);
  }));

  app.patch('/api/orgs/:orgId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    const body = (req.body ?? {}) as UpdateOrganizationRequest;
    const hasBrandingPatch =
      body.websiteUrl !== undefined ||
      body.defaultDesignSystemId !== undefined ||
      body.setupCompleted !== undefined;
    if (hasBrandingPatch || (typeof body.name === 'string' && body.name.trim())) {
      const organization = await updateOrganization(directory(), orgId, {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.websiteUrl !== undefined ? { websiteUrl: body.websiteUrl } : {}),
        ...(body.defaultDesignSystemId !== undefined
          ? { defaultDesignSystemId: body.defaultDesignSystemId }
          : {}),
        ...(body.setupCompleted !== undefined ? { setupCompleted: body.setupCompleted } : {}),
      });
      if (body.websiteUrl !== undefined && organization.websiteUrl) {
        void resolveOrgMark(orgMarkInput(organization)).catch(() => undefined);
      }
      res.json({ organization });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : '';
    res.json({ organization: await renameOrganization(directory(), orgId, name) });
  }));

  // --- Members ------------------------------------------------------------

  app.get('/api/orgs/:orgId/members', handle(async (req, res) => {
    const { orgId } = await scope(req);
    res.json({ members: await listOrgMembers(directory(), orgId) });
  }));

  app.patch('/api/orgs/:orgId/members/:memberId', handle(async (req, res) => {
    const body = (req.body ?? {}) as UpdateOrgMemberRequest;
    const changingStanding = body.role !== undefined || body.status !== undefined;
    const { orgId } = await scope(req, changingStanding ? 'owner' : 'admin');
    const patch: { role?: OrgRole; status?: 'active' | 'removed'; reportsTo?: string | null } = {};
    if (body.role !== undefined) patch.role = body.role;
    if (body.status !== undefined) patch.status = body.status;
    if (body.reportsTo !== undefined) patch.reportsTo = body.reportsTo;
    res.json({ member: await updateOrgMember(directory(), orgId, param(req, 'memberId'), patch) });
  }));

  app.delete('/api/orgs/:orgId/members/:memberId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'owner');
    await getOrgMember(directory(), orgId, param(req, 'memberId'));
    res.json({
      member: await updateOrgMember(directory(), orgId, param(req, 'memberId'), { status: 'removed' }),
    });
  }));

  // --- Teams --------------------------------------------------------------

  app.get('/api/orgs/:orgId/teams', handle(async (req, res) => {
    const { orgId } = await scope(req);
    res.json({ teams: await listOrgTeams(directory(), orgId) });
  }));

  app.post('/api/orgs/:orgId/teams', handle(async (req, res) => {
    const { orgId, member } = await scope(req, 'admin');
    const body = (req.body ?? {}) as CreateOrgTeamRequest;
    res.status(201).json({ team: await createOrgTeam(directory(), orgId, member.id, body) });
  }));

  app.get('/api/orgs/:orgId/teams/:teamId', handle(async (req, res) => {
    const { orgId } = await scope(req);
    res.json({ team: await getOrgTeam(directory(), orgId, param(req, 'teamId')) });
  }));

  app.patch('/api/orgs/:orgId/teams/:teamId', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    const body = (req.body ?? {}) as UpdateOrgTeamRequest;
    res.json({ team: await updateOrgTeam(directory(), orgId, param(req, 'teamId'), body) });
  }));

  app.delete('/api/orgs/:orgId/teams/:teamId', handle(async (req, res) => {
    const { orgId, db } = await scope(req, 'admin');
    const teamId = param(req, 'teamId');
    const team = await deleteOrgTeam(directory(), orgId, teamId);
    await deleteAppTeamGrants(db, orgId, teamId);
    res.json({ team });
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
    const url = joinUrlFor(req, created.token);
    // The token is returned exactly here and never again; only its hash is
    // stored, so a lost link must be re-issued rather than recovered.
    let emailed = false;
    let emailError: string | undefined;
    const shouldEmail = created.invite.kind === 'email' && body.sendEmail !== false;
    if (shouldEmail && created.invite.targetEmail) {
      const credentials = connectors?.getCredential(GMAIL_CONNECTOR_ID)?.credentials;
      if (credentials) {
        try {
          const org = await getOrganization(directory(), orgId);
          await sendMail(createGmailExecutor(credentials), {
            to: [created.invite.targetEmail],
            ...composeOrgInviteEmail({
              orgName: org.name,
              role: created.invite.role,
              url,
            }),
          });
          emailed = true;
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    res.status(201).json({
      invite: created.invite,
      token: created.token,
      url,
      ...(shouldEmail ? { emailed, ...(emailError ? { emailError } : {}) } : {}),
    });
  }));

  app.post('/api/orgs/:orgId/invites/:inviteId/revoke', handle(async (req, res) => {
    const { orgId } = await scope(req, 'admin');
    res.json({ invite: await revokeOrgInvite(directory(), orgId, param(req, 'inviteId')) });
  }));

  // Targeted invites waiting on the signed-in caller. Registered before the
  // token routes so "pending" is never parsed as an invite token.
  app.get('/api/me/invites', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    res.json({ invites: await listPendingInvitesForUser(directory(), viewer.userId) });
  }));

  app.patch('/api/me', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const body = (req.body ?? {}) as UpdateProfileRequest;
    const user = await updateUserProfile(directory(), viewer.userId, {
      ...(typeof body.username === 'string' ? { username: body.username } : {}),
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(typeof body.bio === 'string' ? { bio: body.bio } : {}),
    });
    res.json(toProfile(user));
  }));

  app.put('/api/me/avatar', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const file = await new Promise<Express.Multer.File>((resolve, reject) => {
      avatarUpload.single('file')(req, res, (err: unknown) => {
        if (err) {
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            reject(new WorkspaceDataError('PAYLOAD_TOO_LARGE', 413, 'photo must be under 2 MB'));
            return;
          }
          reject(err);
          return;
        }
        if (!req.file) {
          reject(new WorkspaceDataError('VALIDATION_FAILED', 422, 'photo file is required'));
          return;
        }
        resolve(req.file);
      });
    });
    const mime = await writeAvatarFile(dataDir, viewer.userId, file.buffer);
    const user = await setUserAvatarMime(directory(), viewer.userId, mime);
    res.json(toProfile(user));
  }));

  app.delete('/api/me/avatar', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    await deleteAvatarFile(dataDir, viewer.userId);
    const user = await setUserAvatarMime(directory(), viewer.userId, null);
    res.json(toProfile(user));
  }));

  app.get('/api/users/:userId/avatar', handle(async (req, res) => {
    await viewerFor(req);
    const userId = param(req, 'userId');
    const user = await getUser(directory(), userId);
    if (!user?.avatarMime) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'photo not found');
    }
    const buf = await readAvatarFile(dataDir, userId);
    if (!buf) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'photo not found');
    }
    res.setHeader('Content-Type', user.avatarMime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buf);
  }));

  app.get('/api/users/:username', handle(async (req, res) => {
    await viewerFor(req);
    const user = await getUserByUsername(directory(), param(req, 'username'));
    if (!user || !user.username) {
      throw new WorkspaceDataError('NOT_FOUND', 404, 'user not found');
    }
    res.json({
      userId: user.id,
      displayName: user.displayName,
      username: user.username,
      bio: user.bio,
      avatarUrl: profileAvatarUrl(user.id, user.avatarMime),
    });
  }));

  app.post('/api/me/invites/:inviteId/accept', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const accepted = await acceptPendingInvite(directory(), param(req, 'inviteId'), viewer.userId);
    manager.workspaceExecutor(accepted.organization.id);
    res.json({ organization: accepted.organization, member: accepted.member });
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
      restricted: lookup.value.invite.kind !== 'link',
    });
  }));

  app.post('/api/invites/:token/accept', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const accepted = await acceptOrgInvite(directory(), param(req, 'token'), viewer.userId);
    manager.workspaceExecutor(accepted.organization.id);
    res.json({ organization: accepted.organization, member: accepted.member });
  }));

  // --- Apps ---------------------------------------------------------------

  // Every app across every organization the caller belongs to.
  //
  // Membership is the boundary, exactly as it is for the single-org listing:
  // this widens what you can see in one place, never what you may see. Each
  // row carries its organization's name because a mixed list is unreadable
  // without it.
  app.get('/api/apps', handle(async (req, res) => {
    const viewer = await viewerFor(req);
    const memberships = await listOrganizationsForUser(directory(), viewer.userId);
    const includeArchived = req.query.includeArchived === '1';
    const pinnedOnly = req.query.pinned === '1';
    const apps: Array<OrgApp & { orgName: string }> = [];
    for (const org of memberships) {
      const member = await getActiveMemberForUser(directory(), org.id, viewer.userId);
      if (!member) continue;
      const orgApps = await listApps(manager.workspaceExecutor(org.id), org.id, {
        includeArchived,
        pinnedOnly,
        viewerMemberId: member.id,
        viewerRole: member.role,
        viewerTeamIds: await listTeamIdsForMember(directory(), org.id, member.id),
        resolveMemberName: await memberNameResolver(org.id),
      });
      for (const orgApp of orgApps) apps.push({ ...orgApp, orgName: org.name });
    }
    // One list, newest first, regardless of which organization it came from.
    apps.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ apps: pinnedOnly ? apps.slice(0, 8) : apps });
  }));

  app.get('/api/orgs/:orgId/apps', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    res.json({
      apps: await listApps(db, orgId, {
        includeArchived: req.query.includeArchived === '1',
        pinnedOnly: req.query.pinned === '1',
        viewerMemberId: member.id,
        viewerRole: member.role,
        viewerTeamIds: await listTeamIdsForMember(directory(), orgId, member.id),
        resolveMemberName: await memberNameResolver(orgId),
      }),
    });
  }));

  app.post('/api/orgs/:orgId/apps', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const body = (req.body ?? {}) as PublishAppRequest;
    await assertTeamsExist(orgId, body.teamGrants);
    res.status(201).json({ app: await publishApp(db, orgId, member.id, member.displayName, body) });
  }));

  app.get('/api/orgs/:orgId/apps/:appId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const resolve = await memberNameResolver(orgId);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanViewApp(db, orgId, found, await appViewerFor(orgId, member));
    res.json({ app: { ...found, createdByName: resolve(found.createdBy) } });
  }));

  app.patch('/api/orgs/:orgId/apps/:appId', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const existing = await getApp(db, orgId, param(req, 'appId'));
    await assertCanEditApp(db, orgId, existing, await appViewerFor(orgId, member));
    res.json({ app: await updateApp(db, orgId, param(req, 'appId'), (req.body ?? {}) as UpdateAppRequest) });
  }));

  app.post('/api/orgs/:orgId/apps/:appId/open', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanViewApp(db, orgId, found, await appViewerFor(orgId, member));
    await recordAppOpen(db, found.id);
    res.json({ app: await getApp(db, orgId, found.id) });
  }));

  app.get('/api/orgs/:orgId/apps/:appId/grants', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanViewApp(db, orgId, found, await appViewerFor(orgId, member));
    res.json(await listAppAccess(db, orgId, found.id, await accessResolvers(orgId)));
  }));

  app.put('/api/orgs/:orgId/apps/:appId/grants', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanEditApp(db, orgId, found, await appViewerFor(orgId, member));
    const body = (req.body ?? {}) as SetAppGrantsRequest;
    await assertTeamsExist(orgId, body.teamGrants);
    res.json(await setAppGrants(db, orgId, found.id, body, await accessResolvers(orgId)));
  }));

  app.get('/api/orgs/:orgId/apps/:appId/shares', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanViewApp(db, orgId, found, await appViewerFor(orgId, member));
    res.json({ shares: await listAppShareLinks(db, orgId, param(req, 'appId')) });
  }));

  app.post('/api/orgs/:orgId/apps/:appId/shares', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanEditApp(db, orgId, found, await appViewerFor(orgId, member));
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

  app.post('/api/orgs/:orgId/apps/:appId/publish-web', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanEditApp(db, orgId, found, await appViewerFor(orgId, member));
    res.json(await publishAppToWeb(
      db,
      directory(),
      orgId,
      found.id,
      member.id,
      publicBaseUrl(req),
    ));
  }));

  app.post('/api/orgs/:orgId/apps/:appId/shares/:shareId/revoke', handle(async (req, res) => {
    const { orgId, member, db } = await scope(req);
    const found = await getApp(db, orgId, param(req, 'appId'));
    await assertCanEditApp(db, orgId, found, await appViewerFor(orgId, member));
    res.json({
      share: await revokeAppShareLink(db, directory(), orgId, param(req, 'appId'), param(req, 'shareId')),
    });
  }));

  // Invite landing lives in the web SPA. In split-port tools-dev the daemon
  // is not that origin, so send the browser there. Same-origin packaged /
  // reverse-proxy installs fall through to the SPA fallback.
  app.get('/join/:token', (req, res, next) => {
    const token = param(req, 'token');
    if (!token) {
      next();
      return;
    }
    const browser = browserFacingOrigin(req);
    const here = requestOrigin(req);
    if (browser !== here) {
      res.redirect(302, `${browser}/join/${encodeURIComponent(token)}`);
      return;
    }
    next();
  });

  // --- Public shared-app viewer -------------------------------------------

  // Deliberately outside /api and without any auth: the unguessable token is
  // the entire credential. Registered before the SPA fallback so it wins.
  //
  // Static pages keep the locked-down preview headers (`connect-src 'none'`).
  // Data-connected apps (write scopes) are wrapped in a trusted host that
  // proxies appends to POST /s/:token/data. The untrusted iframe still has
  // no network of its own, so a logged-in member's cookies never reach the
  // app and cannot be used to read organization data.

  function isHtmlAppPath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.html') || lower.endsWith('.htm');
  }

  app.options('/s/:token/data', (_req, res) => {
    setPublicIngestCors(res);
    res.status(204).end();
  });

  app.post('/s/:token/data', handle(async (req, res) => {
    setPublicIngestCors(res);
    const token = param(req, 'token');
    if (!allowPublicIngest(token)) {
      throw new WorkspaceDataError('RATE_LIMITED', 429, 'too many submissions; try again shortly');
    }
    const route = await resolveShareRoute(directory(), token);
    if (!route) {
      throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'this share link is not valid');
    }
    const appsDb = manager.workspaceExecutor(route.orgId);
    const { app: sharedApp, share } = await resolveShareToken(appsDb, route.orgId, token);
    const recordsDb = manager.openWorkspace(route.orgId);
    const { response, created } = handlePublicAppBridge(recordsDb, sharedApp, share.id, req.body);
    if (created) {
      events?.emitRecordChange({
        workspaceId: route.orgId,
        tableId: created.tableId,
        recordId: created.recordId,
        op: 'create',
      });
    }
    res.json(response);
  }));

  app.get('/s/:token', handle(async (req, res) => {
    const token = param(req, 'token');
    const route = await resolveShareRoute(directory(), token);
    if (!route) {
      throw new WorkspaceDataError('APP_SHARE_INVALID', 404, 'this share link is not valid');
    }
    const appsDb = manager.workspaceExecutor(route.orgId);
    const { app: sharedApp, share } = await resolveShareToken(appsDb, route.orgId, token);
    await recordShareView(appsDb, share.id);
    await recordAppOpen(appsDb, sharedApp.id);

    if (appRequestsTableWrites(sharedApp.dataScopes ?? []) && isHtmlAppPath(sharedApp.filePath)) {
      const html = loadAppHtml
        ? await loadAppHtml({ projectId: sharedApp.projectId, filePath: sharedApp.filePath })
        : null;
      if (html == null) {
        throw new WorkspaceDataError('FILE_NOT_FOUND', 404, 'file not found');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', PUBLIC_APP_HOST_CSP);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderPublicAppHost({ appHtml: html, title: sharedApp.name }));
      return;
    }

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
