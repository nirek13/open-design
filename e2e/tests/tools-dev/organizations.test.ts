// @vitest-environment node

// The organization story end to end against a real daemon: an organization
// exists from first boot, you can invite a coworker with a link, publish a
// tool as an app, and share that app outside the member list — with the
// refusals that keep sharing safe.

import { describe, expect, test } from 'vitest';

import { createSmokeSuite } from '@/vitest/suite';
import { requestJson } from '@/vitest/http';
import { listOrganizations } from '@/vitest/workspace-data';

describe('tools-dev organizations', () => {
  test('bootstraps an organization and reports the caller', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tools-dev-org-bootstrap');

    await suite.with.toolsDev(async ({ webUrl }) => {
      const context = await requestJson<{
        mode: string;
        viewer: { userId: string; displayName: string } | null;
        organizations: Array<{ id: string; role: string; memberCount: number }>;
      }>(webUrl, '/api/auth/context');

      // Zero setup: the daemon comes up with an organization you own.
      expect(context.mode).toBe('local-owner');
      expect(context.viewer).not.toBeNull();
      expect(context.organizations).toHaveLength(1);
      expect(context.organizations[0]!.role).toBe('owner');

      const orgs = await listOrganizations(webUrl);
      expect(orgs[0]!.id).toBe(context.organizations[0]!.id);
    });
  });

  test('invites a coworker with a shareable link', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tools-dev-org-invites');

    await suite.with.toolsDev(async ({ webUrl }) => {
      const orgId = (await listOrganizations(webUrl))[0]!.id;

      const created = await requestJson<{ token: string; url: string; invite: { id: string } }>(
        webUrl,
        `/api/orgs/${orgId}/invites`,
        { body: { role: 'member' }, method: 'POST' },
      );
      expect(created.url).toContain(`/join/${created.token}`);

      const landing = await fetch(`${webUrl}/join/${created.token}`);
      expect(landing.status).toBe(200);
      expect(await landing.text()).toMatch(/<html/i);

      // The landing page must work for someone with no session at all.
      const preview = await requestJson<{ valid: boolean; orgName: string; role: string }>(
        webUrl,
        `/api/invites/${created.token}`,
      );
      expect(preview).toMatchObject({ valid: true, role: 'member' });
      expect(preview.orgName.length).toBeGreaterThan(0);

      await requestJson(webUrl, `/api/orgs/${orgId}/invites/${created.invite.id}/revoke`, {
        method: 'POST',
      });
      const revoked = await requestJson<{ valid: boolean; reason: string }>(
        webUrl,
        `/api/invites/${created.token}`,
      );
      expect(revoked).toMatchObject({ valid: false, reason: 'revoked' });
    });
  });

  test('publishes an app and shares it by link', { timeout: 180_000 }, async () => {
    const suite = await createSmokeSuite('tools-dev-org-apps');

    await suite.with.toolsDev(async ({ webUrl }) => {
      const orgId = (await listOrganizations(webUrl))[0]!.id;

      // A real project with a real file, so the share viewer serves bytes
      // rather than a stub.
      const projectId = `proj-${Date.now()}`;
      await requestJson(webUrl, '/api/projects', {
        body: { id: projectId, name: 'Team tools' },
        method: 'POST',
      });
      await requestJson(webUrl, `/api/projects/${projectId}/files`, {
        body: { name: 'lunch.html', content: '<html><body>Lunch order</body></html>' },
        method: 'POST',
      });

      const published = await requestJson<{ app: { id: string; visibility: string } }>(
        webUrl,
        `/api/orgs/${orgId}/apps`,
        {
          body: { name: 'Lunch order', projectId, filePath: 'lunch.html' },
          method: 'POST',
        },
      );
      expect(published.app.visibility).toBe('org');

      const listed = await requestJson<{ apps: Array<{ id: string; name: string }> }>(
        webUrl,
        `/api/orgs/${orgId}/apps`,
      );
      expect(listed.apps.map((entry) => entry.name)).toContain('Lunch order');

      const shared = await requestJson<{ token: string; url: string }>(
        webUrl,
        `/api/orgs/${orgId}/apps/${published.app.id}/shares`,
        { method: 'POST' },
      );

      // Anonymous fetch — no headers, no session.
      const page = await fetch(`${webUrl}/s/${shared.token}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Lunch order');

      // The security line for link sharing: a public page cannot call back
      // into organization data.
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'");

      const unknown = await fetch(`${webUrl}/s/not-a-real-token`);
      expect(unknown.status).toBe(404);
    });
  });
});
