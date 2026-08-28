// Organization mark: the company's harvested logo for the nav-rail dock.
//
// After onboarding saves a website, the dock should show that company's mark
// rather than the Substrate glyph. Harvested brand-project logos win when a
// default design system is linked; otherwise we scrape the website (same
// fallback the brand extractor uses) into `{dataDir}/org-marks/{orgId}/`.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

import { harvestFallbackLogos } from '../brands/logo-fallback.js';
import { resolveProjectDir } from '../projects.js';

const LOGO_EXT_PRIORITY = ['.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.ico'];
const LOGO_FILE_RE = /\.(svg|png|webp|jpe?g|gif|ico)$/i;
const SOURCE_FILE = 'source.txt';
const ORG_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export interface OrgMarkOrg {
  id: string;
  websiteUrl?: string | null;
  defaultDesignSystemId?: string | null;
}

export interface ResolveOrgMarkDeps {
  dataDir: string;
  org: OrgMarkOrg;
  userDesignSystemsRoot?: string | undefined;
  projectsRoot?: string | undefined;
  getProject?: ((projectId: string) => { metadata?: Record<string, unknown> } | null | undefined) | undefined;
  /** Injectable so route tests never hit the network. */
  harvest?: ((siteUrl: string, logosDir: string) => Promise<void>) | undefined;
}

export interface OrgMarkFile {
  buffer: Buffer;
  mime: string;
}

export function orgMarkCacheDir(dataDir: string, orgId: string): string {
  if (!ORG_ID_RE.test(orgId) || orgId === '.' || orgId === '..') {
    throw new Error('invalid organization id');
  }
  return path.join(dataDir, 'org-marks', orgId);
}

export function pickBestMarkFile(dir: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const ranked = names
    .filter((n) => n !== SOURCE_FILE && LOGO_FILE_RE.test(n) && isFileIn(dir, n))
    .sort((a, b) => nameRank(a) - nameRank(b) || extRank(a) - extRank(b) || a.localeCompare(b));
  const pick = ranked[0];
  return pick ? path.join(dir, pick) : null;
}

export function sniffMarkMime(buf: Buffer, filePath?: string): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return 'image/x-icon';
  }
  const head = buf.subarray(0, 256).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) {
    return 'image/svg+xml';
  }
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.ico') return 'image/x-icon';
  return null;
}

const inflight = new Map<string, Promise<OrgMarkFile | null>>();

export async function resolveOrgMark(deps: ResolveOrgMarkDeps): Promise<OrgMarkFile | null> {
  const key = `${deps.org.id}\0${deps.org.websiteUrl ?? ''}\0${deps.org.defaultDesignSystemId ?? ''}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const work = resolveOrgMarkOnce(deps).finally(() => {
    if (inflight.get(key) === work) inflight.delete(key);
  });
  inflight.set(key, work);
  return work;
}

async function resolveOrgMarkOnce(deps: ResolveOrgMarkDeps): Promise<OrgMarkFile | null> {
  const harvested = await readProjectMark(deps);
  if (harvested) return harvested;

  const websiteUrl = typeof deps.org.websiteUrl === 'string' ? deps.org.websiteUrl.trim() : '';
  if (!websiteUrl) return null;

  const cacheDir = orgMarkCacheDir(deps.dataDir, deps.org.id);
  const cached = await readCachedMark(cacheDir, websiteUrl);
  if (cached) return cached;

  const harvest = deps.harvest ?? defaultHarvest;
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  try {
    await harvest(websiteUrl, cacheDir);
  } catch {
    return readFileAsMark(pickBestMarkFile(cacheDir));
  }
  const mark = await readFileAsMark(pickBestMarkFile(cacheDir));
  if (mark) await writeFile(path.join(cacheDir, SOURCE_FILE), `${websiteUrl}\n`, 'utf8');
  return mark;
}

async function defaultHarvest(siteUrl: string, logosDir: string): Promise<void> {
  await harvestFallbackLogos(siteUrl, logosDir);
}

async function readProjectMark(deps: ResolveOrgMarkDeps): Promise<OrgMarkFile | null> {
  const dsId = deps.org.defaultDesignSystemId?.trim();
  if (!dsId || !deps.userDesignSystemsRoot || !deps.projectsRoot || !deps.getProject) {
    return null;
  }
  const dirId = userDesignSystemDirId(dsId);
  if (!dirId) return null;
  let projectId: string | null = null;
  try {
    const raw = await readFile(path.join(deps.userDesignSystemsRoot, dirId, 'metadata.json'), 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : null;
  } catch {
    return null;
  }
  if (!projectId) return null;
  const project = deps.getProject(projectId);
  if (!project) return null;
  let projectRoot: string;
  try {
    projectRoot = resolveProjectDir(deps.projectsRoot, projectId, project.metadata);
  } catch {
    return null;
  }
  return readFileAsMark(pickBestMarkFile(path.join(projectRoot, 'logos')));
}

async function readCachedMark(cacheDir: string, websiteUrl: string): Promise<OrgMarkFile | null> {
  let source: string | null = null;
  try {
    source = (await readFile(path.join(cacheDir, SOURCE_FILE), 'utf8')).trim();
  } catch {
    source = null;
  }
  if (source && source !== websiteUrl) return null;
  return readFileAsMark(pickBestMarkFile(cacheDir));
}

async function readFileAsMark(filePath: string | null): Promise<OrgMarkFile | null> {
  if (!filePath) return null;
  try {
    const buffer = await readFile(filePath);
    const mime = sniffMarkMime(buffer, filePath);
    if (!mime) return null;
    return { buffer, mime };
  } catch {
    return null;
  }
}

function userDesignSystemDirId(id: string): string | null {
  const raw = id.startsWith('user:') ? id.slice('user:'.length) : id;
  if (!/^[a-zA-Z0-9._-]+$/.test(raw) || raw === '.' || raw === '..') return null;
  return raw;
}

function nameRank(name: string): number {
  const n = name.toLowerCase();
  if (n.includes('apple-touch')) return 0;
  if (n.includes('logo')) return 1;
  if (n.includes('favicon')) return 2;
  if (n.startsWith('og-')) return 3;
  return 4;
}

function extRank(name: string): number {
  const i = LOGO_EXT_PRIORITY.indexOf(path.extname(name).toLowerCase());
  return i === -1 ? LOGO_EXT_PRIORITY.length : i;
}

function isFileIn(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}
