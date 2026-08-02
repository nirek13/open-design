// HTTP surface for one-click hosting.
//
// Every route here is a thin pass-through to a Supabase edge function, with two
// exceptions that genuinely need to run on this machine:
//
//   POST /api/projects/:id/publish  reads project files off local disk
//   GET  /api/publish/:id/events    reports progress of that local work
//
// The daemon stores nothing about a published site. It does not cache the live
// version, does not track slugs, and cannot answer "what is published" without
// asking the cloud. That is deliberate: a second source of truth on a laptop is
// exactly what the cloud-only mandate exists to prevent.

import type { Express, Request as ExpressRequest, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  createApiError,
  type ApiErrorCode,
  type HostingCapability,
  type PublishProgress,
  type PublishSiteRequest,
  type RollbackSiteRequest,
  type UpdateSiteRequest,
} from '@open-design/contracts';
import { getProject } from '../db.js';
import { sendApiError } from '../http/response.js';
import { readAuthConfig } from '../auth/identity.js';
import { readHostingConfig, type HostingConfig } from '../hosting/config.js';
import { HostingClient, HostingError } from '../hosting/client.js';
import { publishSite, type PublishEvent } from '../hosting/publish.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface RegisterHostingRoutesDeps {
  db: any;
  paths: { PROJECTS_DIR: string };
}

/**
 * Map a hosting failure onto the daemon's closed error-code union.
 *
 * The specific cloud-side code (SLUG_TAKEN, UPLOAD_INCOMPLETE, …) travels in
 * `details` rather than becoming a new top-level code, so the UI can branch on
 * it without every hosting error needing a contract change.
 */
function statusToCode(status: number): ApiErrorCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UPSTREAM_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

function sendHostingError(res: Response, err: unknown): void {
  if (err instanceof HostingError) {
    sendApiError(
      res,
      err.status,
      createApiError(statusToCode(err.status), err.message, {
        details: { hostingCode: err.code, info: (err.details ?? null) as any },
      }),
    );
    return;
  }
  sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as any)?.message ?? err)));
}

function bearer(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * A stable, non-secret disambiguator for suggested slugs.
 *
 * Derived from the project id rather than randomness so retrying a failed first
 * publish suggests the same name instead of a different one each time.
 */
function slugSuffixFor(projectId: string): string {
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 4).padStart(4, '0');
}

// ---- In-flight publish tracking --------------------------------------------

interface PublishJob {
  publishId: string;
  progress: PublishProgress;
  result: { site: any; version: any; url: string | null } | null;
  error: { status: number; code: string; message: string } | null;
  listeners: Set<(job: PublishJob) => void>;
  finishedAt: number | null;
}

const jobs = new Map<string, PublishJob>();
/** Finished jobs linger briefly so a client that reconnects after the upload
 * completes still receives the outcome rather than a 404. */
const JOB_RETENTION_MS = 5 * 60 * 1000;

function sweepJobs(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
  }
}

function notify(job: PublishJob): void {
  for (const listener of job.listeners) {
    try {
      listener(job);
    } catch {
      // A broken SSE connection must not abort the publish.
    }
  }
}

export function registerHostingRoutes(app: Express, ctx: RegisterHostingRoutesDeps) {
  const { db } = ctx;
  const { PROJECTS_DIR } = ctx.paths;

  /**
   * Resolve config + caller token, or send the reason it is unavailable.
   *
   * Publishing needs a real identity. In local-owner mode there is none — root
   * AGENTS.md is explicit that anyone who can reach the daemon port is the
   * owner — so a publish there would attribute a public site to nobody and an
   * org-restricted site to an organization that cannot be checked.
   */
  function requireClient(req: Request, res: Response): { client: HostingClient; config: HostingConfig } | null {
    const configResult = readHostingConfig();
    if (!configResult.configured) {
      sendApiError(res, 503, createApiError('UPSTREAM_UNAVAILABLE',
        `Hosting is not configured on this daemon (missing ${configResult.missing.join(', ')}).`));
      return null;
    }
    const token = bearer(req);
    if (!token) {
      sendApiError(res, 401, createApiError('UNAUTHORIZED', 'Sign in to publish.'));
      return null;
    }
    return { client: new HostingClient(configResult.config, token), config: configResult.config };
  }

  // ---- Capability ----------------------------------------------------------

  app.get('/api/hosting/capability', (req: Request, res: Response) => {
    const configResult = readHostingConfig();
    const auth = readAuthConfig();
    const signedIn = Boolean(bearer(req));

    const hosting: HostingCapability = configResult.configured
      ? {
          configured: true,
          canPublish: signedIn,
          // Org visibility needs a Clerk organization claim to check against.
          canPublishToOrg: signedIn && auth.mode === 'clerk',
          sitesDomain: configResult.config.sitesDomain,
          reason: signedIn ? null : 'sign-in-required',
        }
      : {
          configured: false,
          canPublish: false,
          canPublishToOrg: false,
          sitesDomain: null,
          reason: 'not-configured',
        };

    res.json({ hosting });
  });

  // ---- Publish -------------------------------------------------------------

  app.post('/api/projects/:id/publish', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;

    const projectId = param(req, 'id');
    const project = getProject(db, projectId);
    if (!project) {
      sendApiError(res, 404, createApiError('PROJECT_NOT_FOUND', 'project not found'));
      return;
    }

    const body = (req.body ?? {}) as PublishSiteRequest;
    if (typeof body.fileName !== 'string' || !body.fileName.trim()) {
      sendApiError(res, 400, createApiError('BAD_REQUEST', 'fileName is required'));
      return;
    }
    const visibility = body.visibility === 'org' ? 'org' : 'public';

    const publishId = randomUUID();
    const job: PublishJob = {
      publishId,
      progress: { siteId: null, phase: 'preparing', uploaded: 0, total: 0, message: null },
      result: null,
      error: null,
      listeners: new Set(),
      finishedAt: null,
    };
    jobs.set(publishId, job);
    sweepJobs();

    // Answer immediately; a large site can take minutes to upload and holding
    // the request open would trip proxy timeouts and give no progress.
    res.status(202).json({ publishId, site: null, progress: job.progress });

    const onEvent = (event: PublishEvent) => {
      job.progress = {
        siteId: event.siteId,
        phase: event.phase,
        uploaded: event.uploaded,
        total: event.total,
        message: event.message,
      };
      notify(job);
    };

    void (async () => {
      try {
        const outcome = await publishSite(resolved.client, {
          projectsRoot: PROJECTS_DIR,
          projectId,
          projectName: project.name ?? 'site',
          projectMetadata: project.metadata,
          fileName: body.fileName.trim(),
          slug: body.slug?.trim() || undefined,
          visibility,
          slugSuffix: slugSuffixFor(projectId),
        }, onEvent);
        job.result = outcome;
      } catch (err) {
        const status = err instanceof HostingError ? err.status : 500;
        const code = err instanceof HostingError ? err.code : 'INTERNAL_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        job.error = { status, code, message };
        job.progress = { ...job.progress, phase: 'failed', message };
      } finally {
        job.finishedAt = Date.now();
        notify(job);
      }
    })();
  });

  app.get('/api/publish/:publishId', (req: Request, res: Response) => {
    const job = jobs.get(param(req, 'publishId'));
    if (!job) {
      sendApiError(res, 404, createApiError('NOT_FOUND', 'unknown publish'));
      return;
    }
    res.json({
      publishId: job.publishId,
      progress: job.progress,
      site: job.result?.site ?? null,
      version: job.result?.version ?? null,
      url: job.result?.url ?? null,
      error: job.error,
    });
  });

  app.get('/api/publish/:publishId/events', (req: Request, res: Response) => {
    const job = jobs.get(param(req, 'publishId'));
    if (!job) {
      sendApiError(res, 404, createApiError('NOT_FOUND', 'unknown publish'));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (current: PublishJob) => {
      res.write(`data: ${JSON.stringify({
        progress: current.progress,
        site: current.result?.site ?? null,
        url: current.result?.url ?? null,
        error: current.error,
      })}\n\n`);
      if (current.finishedAt !== null) res.end();
    };

    // Replay current state immediately so a late subscriber is not left
    // waiting for the next transition on a publish that already finished.
    send(job);
    if (job.finishedAt !== null) return;

    job.listeners.add(send);
    req.on('close', () => {
      job.listeners.delete(send);
    });
  });

  // ---- Site management -----------------------------------------------------

  app.get('/api/sites', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    try {
      res.json(await resolved.client.listSites());
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.get('/api/sites/slug-available', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const suffix = typeof req.query.suffix === 'string' ? req.query.suffix : '';
    try {
      res.json(await resolved.client.slugAvailable(slug, suffix));
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.get('/api/sites/:siteId', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    try {
      res.json(await resolved.client.getSite(param(req, 'siteId')));
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.get('/api/sites/:siteId/versions', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    try {
      res.json(await resolved.client.listVersions(param(req, 'siteId')));
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.patch('/api/sites/:siteId', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    const body = (req.body ?? {}) as UpdateSiteRequest;
    try {
      res.json(await resolved.client.updateSite(param(req, 'siteId'), body));
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.post('/api/sites/:siteId/rollback', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    const body = (req.body ?? {}) as RollbackSiteRequest;
    if (typeof body.versionId !== 'string' || !body.versionId) {
      sendApiError(res, 400, createApiError('BAD_REQUEST', 'versionId is required'));
      return;
    }
    try {
      res.json(await resolved.client.rollback(param(req, 'siteId'), body.versionId));
    } catch (err) {
      sendHostingError(res, err);
    }
  });

  app.post('/api/sites/:siteId/unpublish', async (req: Request, res: Response) => {
    const resolved = requireClient(req, res);
    if (!resolved) return;
    try {
      res.json(await resolved.client.unpublish(param(req, 'siteId')));
    } catch (err) {
      sendHostingError(res, err);
    }
  });
}
