// Daemon-side hosting routes.
//
// The cloud is faked at the fetch boundary rather than by stubbing our own
// client, so these exercise the real request shapes the edge functions will
// receive — including that the caller's Clerk token is forwarded untouched,
// which is the whole basis of the authorization model.

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase } from '../src/db.js';
import { registerHostingRoutes } from '../src/routes/hosting.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

describe('hosting routes', () => {
  let tempDir: string;
  let projectsDir: string;
  let db: any;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  let calls: RecordedCall[] = [];
  let realFetch: typeof globalThis.fetch;
  const originalEnv = { ...process.env };

  /** Responses keyed by a substring of the request URL. */
  let routes: Map<string, { status: number; body: any }>;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-hosting-'));
    projectsDir = path.join(tempDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    db = openDatabase(tempDir, { dataDir: tempDir });

    process.env.OD_HOSTING_FUNCTIONS_URL = 'https://fake.functions.test';
    process.env.OD_HOSTING_SUPABASE_URL = 'https://fake.supabase.test';
    process.env.OD_HOSTING_ANON_KEY = 'anon-key';
    process.env.OD_SITES_DOMAIN = 'od-sites.test';

    calls = [];
    routes = new Map();
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      // The test drives the daemon over real HTTP, so only calls aimed at the
      // fake cloud are intercepted; everything on loopback passes through.
      if (url.includes('127.0.0.1')) return realFetch(input, init);
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      for (const [fragment, response] of routes) {
        if (url.includes(fragment)) {
          return new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_STUBBED', message: url } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const app = express();
    app.use(express.json());
    registerHostingRoutes(app, { db, paths: { PROJECTS_DIR: projectsDir } });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    process.env = { ...originalEnv };
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const authed = (extra: Record<string, string> = {}) => ({
    authorization: 'Bearer clerk-token-abc',
    ...extra,
  });

  /** Response bodies in these tests are assertion fixtures, not typed DTOs. */
  const readBody = async (resp: Response): Promise<any> => resp.json();

  describe('capability', () => {
    it('reports configured and publishable for a signed-in caller', async () => {
      const resp = await fetch(`${base}/api/hosting/capability`, { headers: authed() });
      const body = await readBody(resp);
      expect(body.hosting.configured).toBe(true);
      expect(body.hosting.canPublish).toBe(true);
      expect(body.hosting.sitesDomain).toBe('od-sites.test');
    });

    it('refuses to publish without a token and says why', async () => {
      const resp = await fetch(`${base}/api/hosting/capability`);
      const body = await readBody(resp);
      expect(body.hosting.canPublish).toBe(false);
      expect(body.hosting.reason).toBe('sign-in-required');
    });

    it('reports not-configured when the daemon has no hosting env', async () => {
      delete process.env.OD_HOSTING_FUNCTIONS_URL;
      const resp = await fetch(`${base}/api/hosting/capability`, { headers: authed() });
      const body = await readBody(resp);
      expect(body.hosting.configured).toBe(false);
      expect(body.hosting.reason).toBe('not-configured');
      expect(body.hosting.sitesDomain).toBeNull();
    });

    it('does not offer org visibility outside clerk mode', async () => {
      // local-owner mode has no real identity, so an "org-restricted" site
      // would promise an access control with nothing to enforce it.
      delete process.env.OD_CLERK_ISSUER;
      const resp = await fetch(`${base}/api/hosting/capability`, { headers: authed() });
      const body = await readBody(resp);
      expect(body.hosting.canPublishToOrg).toBe(false);
    });

    it('offers org visibility in clerk mode', async () => {
      process.env.OD_CLERK_ISSUER = 'https://clerk.test';
      const resp = await fetch(`${base}/api/hosting/capability`, { headers: authed() });
      const body = await readBody(resp);
      expect(body.hosting.canPublishToOrg).toBe(true);
    });
  });

  describe('auth gating', () => {
    it('rejects an unauthenticated site listing', async () => {
      const resp = await fetch(`${base}/api/sites`);
      expect(resp.status).toBe(401);
    });

    it('returns 503 rather than a confusing 500 when hosting is unconfigured', async () => {
      delete process.env.OD_SITES_DOMAIN;
      const resp = await fetch(`${base}/api/sites`, { headers: authed() });
      expect(resp.status).toBe(503);
      const body = await readBody(resp);
      expect(body.error.message).toContain('OD_SITES_DOMAIN');
    });
  });

  describe('management pass-through', () => {
    it('forwards the caller token to the edge function', async () => {
      routes.set('sites-manage', { status: 200, body: { sites: [] } });
      await fetch(`${base}/api/sites`, { headers: authed() });
      // The daemon must never mint or swap the credential; the edge function
      // is the only verifier, and it has to see the caller's own token.
      expect(calls[0]?.headers.authorization).toBe('Bearer clerk-token-abc');
    });

    it('maps a cloud 409 onto CONFLICT and preserves the specific code', async () => {
      routes.set('sites-manage', {
        status: 409,
        body: { error: { code: 'SLUG_TAKEN', message: 'my-app is already taken.' } },
      });
      const resp = await fetch(`${base}/api/sites/abc`, {
        method: 'PATCH',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ slug: 'my-app' }),
      });
      expect(resp.status).toBe(409);
      const body = await readBody(resp);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details.hostingCode).toBe('SLUG_TAKEN');
      expect(body.error.message).toContain('already taken');
    });

    it('maps a cloud 429 onto RATE_LIMITED', async () => {
      routes.set('sites-manage', {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'too many publishes' } },
      });
      const resp = await fetch(`${base}/api/sites`, { headers: authed() });
      expect(resp.status).toBe(429);
      expect((await readBody(resp)).error.code).toBe('RATE_LIMITED');
    });

    it('rejects a rollback with no versionId before calling the cloud', async () => {
      const resp = await fetch(`${base}/api/sites/abc/rollback`, {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('surfaces an unreachable cloud as 503, not 500', async () => {
      globalThis.fetch = (async (input: any, init: any = {}) => {
        if (String(input).includes('127.0.0.1')) return realFetch(input, init);
        throw new TypeError('fetch failed');
      }) as typeof globalThis.fetch;
      const resp = await fetch(`${base}/api/sites`, { headers: authed() });
      expect(resp.status).toBe(503);
      expect((await readBody(resp)).error.details.hostingCode).toBe('HOSTING_UNREACHABLE');
    });
  });

  describe('publish', () => {
    function seedProject(): string {
      const projectId = 'proj-1';
      db.prepare(
        `INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ).run(projectId, 'My Site', Date.now(), Date.now());
      const dir = path.join(projectsDir, projectId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'index.html'), '<html><body><h1>Hi</h1></body></html>');
      return projectId;
    }

    it('404s for an unknown project', async () => {
      const resp = await fetch(`${base}/api/projects/nope/publish`, {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ fileName: 'index.html' }),
      });
      expect(resp.status).toBe(404);
    });

    it('requires a fileName', async () => {
      const projectId = seedProject();
      const resp = await fetch(`${base}/api/projects/${projectId}/publish`, {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it('accepts immediately with a publishId rather than holding the request', async () => {
      const projectId = seedProject();
      routes.set('publish-begin', {
        status: 200,
        body: {
          siteId: '11111111-1111-1111-1111-111111111111',
          slug: 'my-site',
          visibility: 'public',
          bucket: 'site-blobs',
          entryFile: 'index.html',
          manifest: {},
          fileCount: 1,
          totalBytes: 10,
          uploads: [],
          skipped: 1,
        },
      });
      routes.set('publish-commit', {
        status: 200,
        body: {
          site: { id: 'site-1', slug: 'my-site' },
          version: { id: 'v1', versionNumber: 1 },
          url: 'https://my-site.od-sites.test',
        },
      });

      const resp = await fetch(`${base}/api/projects/${projectId}/publish`, {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ fileName: 'index.html' }),
      });
      expect(resp.status).toBe(202);
      const started = await readBody(resp);
      expect(typeof started.publishId).toBe('string');

      // Poll to completion. The publish runs after the response, so the job
      // registry is the only way to observe the outcome.
      let state: any = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const poll = await fetch(`${base}/api/publish/${started.publishId}`, { headers: authed() });
        state = await readBody(poll);
        if (state.progress.phase === 'live' || state.error) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(state.error).toBeNull();
      expect(state.progress.phase).toBe('live');
      expect(state.url).toBe('https://my-site.od-sites.test');
    });

    it('reports a failed publish through the job rather than throwing', async () => {
      const projectId = seedProject();
      routes.set('publish-begin', {
        status: 409,
        body: { error: { code: 'SLUG_TAKEN', message: 'taken' } },
      });

      const resp = await fetch(`${base}/api/projects/${projectId}/publish`, {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ fileName: 'index.html', slug: 'taken-name' }),
      });
      const started = await readBody(resp);

      let state: any = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const poll = await fetch(`${base}/api/publish/${started.publishId}`, { headers: authed() });
        state = await readBody(poll);
        if (state.error || state.progress.phase === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(state.error?.code).toBe('SLUG_TAKEN');
      expect(state.progress.phase).toBe('failed');
    });

    it('404s an unknown publish id', async () => {
      const resp = await fetch(`${base}/api/publish/does-not-exist`, { headers: authed() });
      expect(resp.status).toBe(404);
    });
  });
});
