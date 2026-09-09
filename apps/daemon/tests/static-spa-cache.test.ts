// The SPA shell and the hashed assets it points at have opposite caching
// needs, and getting either wrong is invisible until it bites: a cached shell
// pins an open tab to a stale release, and a revalidated asset turns every
// reload into a round trip per chunk.

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStaticSpaFallback } from '../src/static-spa.js';

let staticDir: string;

beforeEach(() => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-static-spa-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>shell</title>');
});

afterEach(() => {
  fs.rmSync(staticDir, { recursive: true, force: true });
});

/** Start the app on an ephemeral port and return its base URL plus a stopper. */
async function serve(app: express.Express) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('SPA shell caching', () => {
  it('serves the fallback shell as revalidate-always', async () => {
    const app = express();
    registerStaticSpaFallback(app, staticDir);
    const { base, stop } = await serve(app);
    try {
      const resp = await fetch(`${base}/some/deep/link`, {
        headers: { accept: 'text/html' },
      });
      expect(resp.status).toBe(200);
      // `no-cache` means "revalidate", not "don't store" — the shell may sit
      // in the cache, but never be reused without asking.
      expect(resp.headers.get('cache-control')).toBe('no-cache');
    } finally {
      await stop();
    }
  });

  it('leaves non-shell requests to the next handler', async () => {
    const app = express();
    registerStaticSpaFallback(app, staticDir);
    app.use((_req, res) => res.status(418).end());
    const { base, stop } = await serve(app);
    try {
      // `/api/*` is the daemon's own surface and must never receive the shell.
      const resp = await fetch(`${base}/api/health`, { headers: { accept: 'text/html' } });
      expect(resp.status).toBe(418);
    } finally {
      await stop();
    }
  });
});
