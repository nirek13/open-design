// Auto-publish a project to one-click hosting so Public create lands on a
// live web URL without opening the Publish panel.

import { fetchProjectFiles, uploadProjectFile } from './registry';
import {
  HostingRequestError,
  fetchHostingCapability,
  startPublish,
  watchPublish,
} from './hosting';

export type AutoPublishResult =
  | { ok: true; url: string; fileName: string }
  | { ok: false; reason: string };

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'project';
}

function placeholderHtml(projectName: string): string {
  const safe = projectName.replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: #0b0b0c;
      color: #f4f4f5;
    }
    main { text-align: center; padding: 2rem; max-width: 28rem; }
    h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { margin: 0; opacity: 0.7; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${safe}</h1>
    <p>This page is live. Your design will appear here as soon as it is ready.</p>
  </main>
</body>
</html>
`;
}

/** Prefer an existing HTML entry; otherwise seed a live placeholder. */
export async function resolveOrSeedPublishFile(
  projectId: string,
  projectName: string,
): Promise<string | null> {
  const files = await fetchProjectFiles(projectId);
  const html = files.find(
    (file) =>
      /\.html?$/i.test(file.name) ||
      (typeof file.path === 'string' && /\.html?$/i.test(file.path)),
  );
  if (html) return html.path || html.name;

  const blob = new File(
    [placeholderHtml(projectName)],
    'index.html',
    { type: 'text/html' },
  );
  const uploaded = await uploadProjectFile(projectId, blob, 'index.html');
  return uploaded?.path || uploaded?.name || 'index.html';
}

/**
 * Publish (or republish) a project to the public web.
 * Returns the live URL when hosting is configured and the caller is signed in.
 */
export async function publishProjectNow(input: {
  projectId: string;
  projectName: string;
  /** Defaults to `public` (anyone with the link). Use `org` for org-only. */
  visibility?: 'public' | 'org';
  fileName?: string;
}): Promise<AutoPublishResult> {
  const visibility = input.visibility ?? 'public';
  try {
    const capability = await fetchHostingCapability();
    if (!capability.canPublish) {
      const reason =
        capability.reason === 'sign-in-required'
          ? 'Sign in to publish a public web link.'
          : capability.reason === 'not-configured'
            ? 'Public hosting is not configured on this install.'
            : 'Cannot publish right now.';
      return { ok: false, reason };
    }
    if (visibility === 'org' && !capability.canPublishToOrg) {
      return { ok: false, reason: 'Organization-only links need Clerk organizations.' };
    }

    const fileName =
      input.fileName ??
      (await resolveOrSeedPublishFile(input.projectId, input.projectName));
    if (!fileName) {
      return { ok: false, reason: 'No HTML file to publish.' };
    }

    const started = await startPublish(input.projectId, {
      fileName,
      visibility,
      slug: slugify(input.projectName),
    }).catch(async (err) => {
      // Slug collisions are common on retry; let the cloud suggest one.
      if (err instanceof HostingRequestError && /slug|taken|conflict/i.test(err.message + err.code)) {
        return startPublish(input.projectId, { fileName, visibility });
      }
      throw err;
    });

    return await new Promise<AutoPublishResult>((resolve) => {
      const stop = watchPublish(started.publishId, (state) => {
        if (state.error) {
          stop();
          resolve({ ok: false, reason: state.error.message });
          return;
        }
        if (state.progress.phase === 'live') {
          stop();
          const url =
            state.url ||
            state.site?.url ||
            (state.site?.slug && capability.sitesDomain
              ? `https://${state.site.slug}.${capability.sitesDomain}`
              : null);
          if (!url) {
            resolve({ ok: false, reason: 'Published, but no URL was returned.' });
            return;
          }
          resolve({ ok: true, url, fileName });
        }
      });
    });
  } catch (err) {
    const reason =
      err instanceof HostingRequestError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Publish failed.';
    return { ok: false, reason };
  }
}
