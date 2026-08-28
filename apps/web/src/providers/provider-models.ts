import type {
  ProviderModelsRequest,
  ProviderModelsResponse,
} from '../types';

const KEYLESS_PROVIDER_PROTOCOLS = new Set(['aihubmix', 'bedrock']);

function incompleteProviderModelsRequest(body: ProviderModelsRequest): string | null {
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const needsKey = !KEYLESS_PROVIDER_PROTOCOLS.has(body.protocol);
  if (!baseUrl) return needsKey ? 'baseUrl and apiKey are required' : 'baseUrl is required';
  if (needsKey && !apiKey) return 'baseUrl and apiKey are required';
  return null;
}

async function postProviderModels(
  body: ProviderModelsRequest,
  signal?: AbortSignal,
): Promise<ProviderModelsResponse> {
  const start = Date.now();
  try {
    const response = await fetch('/api/provider/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = (await response.json()) as
          | { error?: { message?: string }; message?: string }
          | null;
        detail = payload?.error?.message ?? payload?.message;
      } catch {
        // body was not JSON; keep detail undefined.
      }
      return {
        ok: false,
        kind: 'unknown',
        latencyMs: Date.now() - start,
        detail: detail ?? `Daemon responded with ${response.status}`,
        status: response.status,
      };
    }
    return (await response.json()) as ProviderModelsResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      kind: 'unknown',
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

export function fetchProviderModels(
  input: ProviderModelsRequest,
  signal?: AbortSignal,
): Promise<ProviderModelsResponse> {
  const incomplete = incompleteProviderModelsRequest(input);
  if (incomplete) {
    return Promise.resolve({
      ok: false,
      kind: 'unknown',
      latencyMs: 0,
      detail: incomplete,
      status: 400,
    });
  }
  return postProviderModels(input, signal);
}
