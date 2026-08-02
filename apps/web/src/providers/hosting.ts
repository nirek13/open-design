// Web client for one-click hosting.
//
// Everything here talks to the daemon, never to Supabase directly. The daemon
// is the only process that can read project files, and routing the management
// calls through it too keeps one authenticated path instead of two — the web
// app never needs Supabase keys or a storage endpoint.

import type {
  HostingCapability,
  HostedSite,
  HostedSiteVersion,
  PublishProgress,
  PublishSiteRequest,
  SiteVisibility,
  SlugAvailabilityResponse,
} from '@open-design/contracts';

export interface PublishStartResponse {
  publishId: string;
  site: HostedSite | null;
  progress: PublishProgress;
}

export interface PublishStateResponse {
  publishId: string;
  progress: PublishProgress;
  site: HostedSite | null;
  version: HostedSiteVersion | null;
  url: string | null;
  error: { status: number; code: string; message: string } | null;
}

export class HostingRequestError extends Error {
  code: string;
  status: number;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'HostingRequestError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string; code?: string; details?: { hostingCode?: string } } }
      | null;
    // The daemon maps cloud-side codes onto its closed error union and carries
    // the specific one in details.hostingCode, which is what the UI branches on
    // (SLUG_TAKEN needs a different affordance than RATE_LIMITED).
    const code = payload?.error?.details?.hostingCode ?? payload?.error?.code ?? 'HOSTING_ERROR';
    throw new HostingRequestError(
      payload?.error?.message || `Request failed (${resp.status})`,
      resp.status,
      code,
    );
  }
  return resp.json() as Promise<T>;
}

export async function fetchHostingCapability(): Promise<HostingCapability> {
  const body = await request<{ hosting: HostingCapability }>('/api/hosting/capability');
  return body.hosting;
}

export function startPublish(
  projectId: string,
  input: PublishSiteRequest,
): Promise<PublishStartResponse> {
  return request<PublishStartResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/publish`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function fetchPublishState(publishId: string): Promise<PublishStateResponse> {
  return request<PublishStateResponse>(`/api/publish/${encodeURIComponent(publishId)}`);
}

/**
 * Follow a publish to completion.
 *
 * Uses SSE, with a polling fallback for environments where the event stream
 * cannot be established (a proxy that buffers, most often). Publishing a large
 * site takes minutes, so silently showing no progress is not an acceptable
 * degradation — the fallback keeps the UI honest.
 */
export function watchPublish(
  publishId: string,
  onProgress: (state: PublishStateResponse) => void,
): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (state: PublishStateResponse) => {
    onProgress(state);
    if (state.error || state.progress.phase === 'live') stop();
  };

  const poll = async () => {
    if (stopped) return;
    try {
      finish(await fetchPublishState(publishId));
    } catch {
      // Transient failures are expected while the daemon is busy uploading;
      // keep polling rather than tearing the UI down.
    }
    if (!stopped) pollTimer = setTimeout(poll, 1000);
  };

  function stop() {
    stopped = true;
    source?.close();
    if (pollTimer) clearTimeout(pollTimer);
  }

  try {
    source = new EventSource(`/api/publish/${encodeURIComponent(publishId)}/events`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as Partial<PublishStateResponse>;
        finish({
          publishId,
          progress: parsed.progress ?? { siteId: null, phase: 'preparing', uploaded: 0, total: 0, message: null },
          site: parsed.site ?? null,
          version: parsed.version ?? null,
          url: parsed.url ?? null,
          error: parsed.error ?? null,
        });
      } catch {
        // Ignore an unparseable frame; the next one or the fallback will do.
      }
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (!stopped && !pollTimer) void poll();
    };
  } catch {
    void poll();
  }

  return stop;
}

export async function listSites(): Promise<HostedSite[]> {
  const body = await request<{ sites: HostedSite[] }>('/api/sites');
  return body.sites ?? [];
}

export async function listSiteVersions(siteId: string): Promise<HostedSiteVersion[]> {
  const body = await request<{ versions: HostedSiteVersion[] }>(
    `/api/sites/${encodeURIComponent(siteId)}/versions`,
  );
  return body.versions ?? [];
}

export function checkSlug(slug: string, suffix = ''): Promise<SlugAvailabilityResponse> {
  const query = new URLSearchParams({ slug, suffix });
  return request<SlugAvailabilityResponse>(`/api/sites/slug-available?${query}`);
}

export async function updateSite(
  siteId: string,
  patch: { slug?: string; visibility?: SiteVisibility },
): Promise<HostedSite> {
  const body = await request<{ site: HostedSite }>(`/api/sites/${encodeURIComponent(siteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return body.site;
}

export async function rollbackSite(siteId: string, versionId: string): Promise<HostedSite> {
  const body = await request<{ site: HostedSite }>(
    `/api/sites/${encodeURIComponent(siteId)}/rollback`,
    { method: 'POST', body: JSON.stringify({ versionId }) },
  );
  return body.site;
}

export async function unpublishSite(siteId: string): Promise<HostedSite> {
  const body = await request<{ site: HostedSite }>(
    `/api/sites/${encodeURIComponent(siteId)}/unpublish`,
    { method: 'POST' },
  );
  return body.site;
}
