import { describe, expect, it } from 'vitest';
import {
  PUBLIC_APP_HOST_CSP,
  allowPublicIngest,
  renderPublicAppHost,
  setPublicIngestCors,
} from '../src/workspace-data/public-app-host.js';

describe('public app host', () => {
  it('wraps the untrusted page in a sandboxed iframe with the shared SDK', () => {
    const html = renderPublicAppHost({
      appHtml: '<form><button>Send</button></form>',
      title: 'Intake',
    });

    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain("credentials: 'omit'");
    expect(html).toContain("fetch('data'");
    expect(html).toContain('<form><button>Send</button></form>');
    expect(html).toContain('window.od');
  });

  it('keeps the trusted parent on connect-src self, not none', () => {
    expect(PUBLIC_APP_HOST_CSP).toContain("connect-src 'self'");
    expect(PUBLIC_APP_HOST_CSP).not.toMatch(/connect-src 'none'/);
  });

  it('rate-limits a share token inside a one-minute window', () => {
    const token = 'share-rate-limit-token';
    const start = 1_700_000_000_000;
    for (let i = 0; i < 30; i += 1) {
      expect(allowPublicIngest(token, start)).toBe(true);
    }
    expect(allowPublicIngest(token, start)).toBe(false);
    expect(allowPublicIngest(token, start + 60_000)).toBe(true);
  });

  it('advertises cookie-less CORS so a hosted copy can POST ingest', () => {
    const headers: Record<string, string> = {};
    setPublicIngestCors({
      setHeader(name, value) {
        headers[name] = value;
      },
    });
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toContain('POST');
  });
});
