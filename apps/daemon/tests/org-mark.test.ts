import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  orgMarkCacheDir,
  pickBestMarkFile,
  resolveOrgMark,
  sniffMarkMime,
} from '../src/workspace-data/org-mark.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('org mark', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-org-mark-'));
    dirs.push(dir);
    return dir;
  }

  it('picks a logo file over a favicon icon', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
    writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(path.basename(pickBestMarkFile(dir) ?? '')).toBe('logo.svg');
  });

  it('serves a cached scrape of the company website', async () => {
    const dataDir = tempDir();
    const orgId = 'ws-mark-1';
    const cache = orgMarkCacheDir(dataDir, orgId);
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, 'apple-touch-icon.png'), PNG);
    writeFileSync(path.join(cache, 'source.txt'), 'https://stripe.com\n');

    const mark = await resolveOrgMark({
      dataDir,
      org: { id: orgId, websiteUrl: 'https://stripe.com' },
      harvest: async () => {
        throw new Error('must not scrape when the cache is warm');
      },
    });
    expect(mark?.mime).toBe('image/png');
    expect(mark?.buffer.equals(PNG)).toBe(true);
  });

  it('scrapes the website into the cache when nothing is on disk', async () => {
    const dataDir = tempDir();
    const harvested = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const mark = await resolveOrgMark({
      dataDir,
      org: { id: 'ws-mark-2', websiteUrl: 'https://stripe.com' },
      harvest: async (_url, logosDir) => {
        mkdirSync(logosDir, { recursive: true });
        writeFileSync(path.join(logosDir, 'logo.svg'), harvested);
      },
    });
    expect(mark?.mime).toBe('image/svg+xml');
    expect(mark?.buffer.equals(harvested)).toBe(true);
  });

  it('prefers a harvested brand-project logo over a website scrape', async () => {
    const dataDir = tempDir();
    const projectsRoot = path.join(dataDir, 'projects');
    const dsRoot = path.join(dataDir, 'design-systems');
    const projectId = 'brand-stripe-1';
    mkdirSync(path.join(projectsRoot, projectId, 'logos'), { recursive: true });
    mkdirSync(path.join(dsRoot, 'kit-1'), { recursive: true });
    writeFileSync(path.join(projectsRoot, projectId, 'logos', 'logo.svg'), '<svg id="brand"></svg>');
    writeFileSync(path.join(dsRoot, 'kit-1', 'metadata.json'), JSON.stringify({ projectId }));

    const mark = await resolveOrgMark({
      dataDir,
      org: {
        id: 'ws-mark-3',
        websiteUrl: 'https://stripe.com',
        defaultDesignSystemId: 'user:kit-1',
      },
      userDesignSystemsRoot: dsRoot,
      projectsRoot,
      getProject: (id) => (id === projectId ? { metadata: {} } : null),
      harvest: async () => {
        throw new Error('must not scrape when a project logo exists');
      },
    });
    expect(mark?.mime).toBe('image/svg+xml');
    expect(mark?.buffer.toString('utf8')).toContain('id="brand"');
  });

  it('sniffs common image types', () => {
    expect(sniffMarkMime(PNG)).toBe('image/png');
    expect(sniffMarkMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    );
  });
});
