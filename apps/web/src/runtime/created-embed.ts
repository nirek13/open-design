// Catalogue of things a person built in Open Design that can sit live inside
// a wiki page: published apps, pictures, videos, and HTML slides.

import type { OrgApp, Project, ProjectFile } from '@open-design/contracts';
import { fetchOrgApps, fetchProjectFiles } from '../providers/registry';
import { listProjects } from '../state/projects';

export type CreatedEmbedKind = 'app' | 'image' | 'video' | 'slides';

export interface CreatedEmbedItem {
  id: string;
  kind: CreatedEmbedKind;
  title: string;
  subtitle: string;
  url: string;
  thumbUrl?: string;
}

export interface CreatedEmbedDeps {
  listApps: (orgId: string) => Promise<OrgApp[]>;
  listProjects: () => Promise<Project[]>;
  listFiles: (projectId: string) => Promise<ProjectFile[]>;
}

const MAX_PROJECTS = 16;
const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const DECK_NAME = /(?:^|[-_\s./])(deck|slides?|pitch|presentation)(?:[-_\s.]|$)/i;

const DEFAULT_DEPS: CreatedEmbedDeps = {
  listApps: (orgId) => fetchOrgApps(orgId),
  listProjects: () => listProjects(),
  listFiles: (projectId) => fetchProjectFiles(projectId),
};

export function createdFileUrl(projectId: string, filePath: string): string {
  const safePath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${safePath}`;
}

export function isDeckPath(path: string): boolean {
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return DECK_NAME.test(name) || DECK_NAME.test(path);
}

export function classifyCreatedFile(file: ProjectFile): CreatedEmbedKind | null {
  if (file.type === 'dir') return null;
  const rel = (file.path || file.name || '').trim();
  if (!rel || rel.startsWith('.')) return null;

  if (file.kind === 'image' || IMAGE_EXT.test(rel)) return 'image';
  if (file.kind === 'video' || VIDEO_EXT.test(rel)) return 'video';

  const html = file.kind === 'html' || HTML_EXT.test(rel);
  if (html && (file.artifactKind === 'deck' || isDeckPath(rel))) return 'slides';
  if (html) return 'app';
  return null;
}

export async function loadCreatedEmbedItems(
  orgId: string,
  deps: CreatedEmbedDeps = DEFAULT_DEPS,
): Promise<CreatedEmbedItem[]> {
  const [apps, projects] = await Promise.all([
    deps.listApps(orgId).catch(() => [] as OrgApp[]),
    deps.listProjects().catch(() => [] as Project[]),
  ]);

  const items: CreatedEmbedItem[] = [];
  const seen = new Set<string>();

  for (const app of apps) {
    if (app.status === 'archived') continue;
    const url = createdFileUrl(app.projectId, app.filePath);
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      id: `app:${app.id}`,
      kind: 'app',
      title: app.name,
      subtitle: app.filePath,
      url,
    });
  }

  const recent = [...projects]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_PROJECTS);

  const groups = await Promise.all(
    recent.map(async (project) => ({
      project,
      files: await deps.listFiles(project.id).catch(() => [] as ProjectFile[]),
    })),
  );

  for (const { project, files } of groups) {
    for (const file of files) {
      const kind = classifyCreatedFile(file);
      if (!kind) continue;
      const rel = (file.path || file.name).trim();
      const url = createdFileUrl(project.id, rel);
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({
        id: `file:${project.id}:${rel}`,
        kind,
        title: titleFromPath(rel),
        subtitle: project.name,
        url,
        thumbUrl: kind === 'image' ? url : undefined,
      });
    }
  }

  return items;
}

function titleFromPath(path: string): string {
  const base = path.split('/').filter(Boolean).at(-1) ?? path;
  const stem = base.replace(/\.[^.]+$/, '');
  const spaced = stem.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return base;
  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}
