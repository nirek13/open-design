// Thin HTTP client for the hosting edge functions.
//
// Every method forwards the caller's Clerk bearer token untouched. The daemon
// deliberately does not verify that token: it is not the audience for it, and a
// second verifier here would be a second thing to keep correct. The edge
// function verifies it, and its answer is the only one that matters.

import type { HostingConfig } from './config.js';

export class HostingError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(message: string, status = 502, code = 'HOSTING_ERROR', details?: unknown) {
    super(message);
    this.name = 'HostingError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface UploadTarget {
  hash: string;
  path: string;
  token: string;
}

export interface BeginResponse {
  siteId: string;
  slug: string;
  visibility: 'public' | 'org';
  bucket: string;
  entryFile: string;
  manifest: Record<string, { hash: string; size: number; contentType: string }>;
  fileCount: number;
  totalBytes: number;
  uploads: UploadTarget[];
  skipped: number;
}

export class HostingClient {
  constructor(private readonly config: HostingConfig, private readonly token: string) {}

  private async call<T>(fn: string, init: RequestInit & { path?: string } = {}): Promise<T> {
    const { path = '', ...rest } = init;
    const url = `${this.config.functionsUrl}/${fn}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: {
          authorization: `Bearer ${this.token}`,
          apikey: this.config.anonKey,
          ...(rest.body ? { 'content-type': 'application/json' } : {}),
          ...(rest.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      // A network failure reaching our own cloud is our problem, and the
      // message should say so rather than surfacing a raw fetch error.
      throw new HostingError(
        `Could not reach the hosting service: ${err instanceof Error ? err.message : String(err)}`,
        503,
        'HOSTING_UNREACHABLE',
      );
    }

    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const code = body?.error?.code ?? 'HOSTING_ERROR';
      const message = body?.error?.message ?? `hosting request failed (${response.status})`;
      throw new HostingError(message, response.status, code, body?.violations ?? body?.missing);
    }
    return body as T;
  }

  begin(input: unknown): Promise<BeginResponse> {
    return this.call<BeginResponse>('publish-begin', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  commit(input: unknown): Promise<any> {
    return this.call('publish-commit', { method: 'POST', body: JSON.stringify(input) });
  }

  listSites(): Promise<{ sites: any[] }> {
    return this.call('sites-manage', { method: 'GET' });
  }

  getSite(siteId: string): Promise<{ site: any }> {
    return this.call('sites-manage', { method: 'GET', path: `/${encodeURIComponent(siteId)}` });
  }

  listVersions(siteId: string): Promise<{ versions: any[] }> {
    return this.call('sites-manage', {
      method: 'GET',
      path: `/${encodeURIComponent(siteId)}/versions`,
    });
  }

  updateSite(siteId: string, patch: unknown): Promise<{ site: any }> {
    return this.call('sites-manage', {
      method: 'PATCH',
      path: `/${encodeURIComponent(siteId)}`,
      body: JSON.stringify(patch),
    });
  }

  rollback(siteId: string, versionId: string): Promise<{ site: any }> {
    return this.call('sites-manage', {
      method: 'POST',
      path: `/${encodeURIComponent(siteId)}/rollback`,
      body: JSON.stringify({ versionId }),
    });
  }

  unpublish(siteId: string): Promise<{ site: any }> {
    return this.call('sites-manage', {
      method: 'POST',
      path: `/${encodeURIComponent(siteId)}/unpublish`,
    });
  }

  slugAvailable(slug: string, suffix: string): Promise<{
    slug: string;
    available: boolean;
    reason: string | null;
    suggestion: string | null;
  }> {
    const query = new URLSearchParams({ slug, suffix });
    return this.call('sites-manage', { method: 'GET', path: `/slug-available?${query}` });
  }

  /**
   * Upload one blob to a signed target.
   *
   * Uses the Storage upload-signed-url endpoint directly rather than the
   * Supabase JS client, so the daemon does not take a dependency on an SDK to
   * send four headers and a body.
   */
  async uploadBlob(
    bucket: string,
    target: UploadTarget,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const url = `${this.config.supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${target.path}?token=${encodeURIComponent(target.token)}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        apikey: this.config.anonKey,
        // Blob names are content hashes, so re-uploading the same name is
        // always the same bytes; treating a repeat as an error would make a
        // retried publish fail for no reason.
        'x-upsert': 'true',
      },
      // Zero-copy view over the same memory: Buffer satisfies BodyInit, a bare
      // Uint8Array does not under this lib configuration.
      body: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new HostingError(
        `Upload failed for ${target.hash.slice(0, 8)} (${response.status}) ${detail}`.trim(),
        502,
        'UPLOAD_FAILED',
      );
    }
  }
}
