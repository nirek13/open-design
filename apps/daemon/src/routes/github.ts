// Organization GitHub client over HTTP.
//
// Same membership scoping as mail / calendar / slack. Repos, PRs, and issues
// stay on GitHub via Composio — nothing is stored in the org database.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  type CommentGithubIssueRequest,
  type CreateGithubIssueRequest,
  type MergeGithubPullRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import type { ConnectorService } from '../connectors/service.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
} from '../workspace-data/tenancy.js';
import {
  commentGithubIssue,
  createGithubExecutor,
  createGithubIssue,
  fetchGithubProfile,
  GITHUB_CONNECTOR_ID,
  getGithubIssue,
  getGithubPull,
  getGithubRepo,
  listGithubComments,
  listGithubCommits,
  listGithubIssues,
  listGithubNotifications,
  listGithubPulls,
  listGithubRepos,
  listGithubWorkflowRuns,
  mergeGithubPull,
  starGithubRepo,
} from '../workspace-data/github.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface GithubRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  connectors: ConnectorService;
}

export interface RegisterGithubRoutesDeps extends RouteDeps<'db' | 'auth'> {
  github: GithubRouteServices;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, `${label} is required`);
  }
  return value as Record<string, unknown>;
}

function asCreateIssueBody(value: unknown): CreateGithubIssueRequest {
  const body = asObject(value, 'request body');
  return {
    title: typeof body.title === 'string' ? body.title : '',
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
  };
}

function asCommentBody(value: unknown): CommentGithubIssueRequest {
  const body = asObject(value, 'request body');
  return { body: typeof body.body === 'string' ? body.body : '' };
}

function asMergeBody(value: unknown): MergeGithubPullRequest {
  const body = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const method = body.method;
  return {
    method: method === 'merge' || method === 'squash' || method === 'rebase' ? method : 'squash',
  };
}

function issueNumber(req: Request): number {
  const n = Number(param(req, 'number'));
  if (!Number.isInteger(n) || n <= 0) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'issue or pull number is required');
  }
  return n;
}

export function registerGithubRoutes(app: Express, ctx: RegisterGithubRoutesDeps): void {
  const { manager, identity, connectors } = ctx.github;
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
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as Error)?.message ?? err)));
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

  async function scope(req: Request, minimum: 'member' | 'admin' | 'owner' = 'member') {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    return { orgId };
  }

  function githubConnected(): boolean {
    try {
      return Boolean(connectors.getCredential(GITHUB_CONNECTOR_ID)?.credentials);
    } catch {
      return false;
    }
  }

  function requireExecutor() {
    if (!githubConnected()) {
      throw new WorkspaceDataError(
        'CONNECTOR_NOT_CONNECTED',
        400,
        'Connect GitHub under Integrations first',
      );
    }
    const credentials = connectors.getCredential(GITHUB_CONNECTOR_ID)?.credentials;
    return createGithubExecutor(credentials);
  }

  app.get(
    '/api/orgs/:orgId/github/status',
    handle(async (req, res) => {
      await scope(req);
      if (!githubConnected()) {
        res.json({ connected: false, profile: null });
        return;
      }
      res.json({ connected: true, profile: await fetchGithubProfile(requireExecutor()) });
    }),
  );

  app.get(
    '/api/orgs/:orgId/github/repos',
    handle(async (req, res) => {
      await scope(req);
      if (!githubConnected()) {
        res.json({ connected: false, profile: null, repos: [] });
        return;
      }
      const exec = requireExecutor();
      const query = typeof req.query.q === 'string' ? req.query.q : undefined;
      const [profile, repos] = await Promise.all([
        fetchGithubProfile(exec),
        listGithubRepos(exec, query ? { query } : undefined),
      ]);
      res.json({ connected: true, profile, repos });
    }),
  );

  app.get(
    '/api/orgs/:orgId/github/notifications',
    handle(async (req, res) => {
      await scope(req);
      if (!githubConnected()) {
        res.json({ connected: false, notifications: [] });
        return;
      }
      res.json({
        connected: true,
        notifications: await listGithubNotifications(requireExecutor()),
      });
    }),
  );

  app.get(
    '/api/orgs/:orgId/github/repos/:owner/:repo',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const owner = param(req, 'owner');
      const repo = param(req, 'repo');
      const [detail, pulls, issues, commits, workflowRuns] = await Promise.all([
        getGithubRepo(exec, owner, repo),
        listGithubPulls(exec, owner, repo).catch(() => []),
        listGithubIssues(exec, owner, repo).catch(() => []),
        listGithubCommits(exec, owner, repo).catch(() => []),
        listGithubWorkflowRuns(exec, owner, repo).catch(() => []),
      ]);
      res.json({ repo: detail, pulls, issues, commits, workflowRuns });
    }),
  );

  app.get(
    '/api/orgs/:orgId/github/repos/:owner/:repo/pulls/:number',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const owner = param(req, 'owner');
      const repo = param(req, 'repo');
      const number = issueNumber(req);
      const [pull, comments] = await Promise.all([
        getGithubPull(exec, owner, repo, number),
        listGithubComments(exec, owner, repo, number),
      ]);
      res.json({ pull, comments });
    }),
  );

  app.get(
    '/api/orgs/:orgId/github/repos/:owner/:repo/issues/:number',
    handle(async (req, res) => {
      await scope(req);
      const exec = requireExecutor();
      const owner = param(req, 'owner');
      const repo = param(req, 'repo');
      const number = issueNumber(req);
      const [issue, comments] = await Promise.all([
        getGithubIssue(exec, owner, repo, number),
        listGithubComments(exec, owner, repo, number),
      ]);
      res.json({ issue, comments });
    }),
  );

  app.post(
    '/api/orgs/:orgId/github/repos/:owner/:repo/issues',
    handle(async (req, res) => {
      await scope(req);
      const body = asCreateIssueBody(req.body);
      const issue = await createGithubIssue(
        requireExecutor(),
        param(req, 'owner'),
        param(req, 'repo'),
        body.title,
        body.body,
      );
      res.status(201).json({ issue });
    }),
  );

  app.post(
    '/api/orgs/:orgId/github/repos/:owner/:repo/issues/:number/comments',
    handle(async (req, res) => {
      await scope(req);
      const body = asCommentBody(req.body);
      const comment = await commentGithubIssue(
        requireExecutor(),
        param(req, 'owner'),
        param(req, 'repo'),
        issueNumber(req),
        body.body,
      );
      res.status(201).json({ comment });
    }),
  );

  app.post(
    '/api/orgs/:orgId/github/repos/:owner/:repo/pulls/:number/merge',
    handle(async (req, res) => {
      await scope(req);
      const body = asMergeBody(req.body);
      const pull = await mergeGithubPull(
        requireExecutor(),
        param(req, 'owner'),
        param(req, 'repo'),
        issueNumber(req),
        body.method,
      );
      res.json({ pull });
    }),
  );

  app.post(
    '/api/orgs/:orgId/github/repos/:owner/:repo/star',
    handle(async (req, res) => {
      await scope(req);
      await starGithubRepo(requireExecutor(), param(req, 'owner'), param(req, 'repo'));
      res.json({ ok: true });
    }),
  );
}
