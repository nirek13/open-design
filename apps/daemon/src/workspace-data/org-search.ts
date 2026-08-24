// One box over everything in the organization the caller can see.
//
// People type "Jane's onboarding deck" or "the Q3 invoice", not table names.
// Search gathers every surface, drops anything outside the reporting chain,
// then ranks the rest with a small natural-language scorer (stopwords out,
// tokens against title/body, kind words bias the matching surface).

import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { OrgApp, OrgSearchHit, OrgSearchKind, OrgRole, Project } from '@open-design/contracts';
import { personLabel } from '@open-design/contracts';
import { listProjects } from '../db.js';
import { listFiles } from '../projects.js';
import type { SqlExecutor } from '../storage/sql.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { listApps } from './apps.js';
import { listCalendarEvents } from './calendar.js';
import { searchMessages } from './chat.js';
import { ownerInHierarchyScope, visibleMemberIds } from './hierarchy.js';
import { listPages, searchPages } from './pages.js';
import { listTeamIdsForMember, listOrgMembers } from './tenancy.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'from', 'with', 'about',
  'and', 'or', 'my', 'our', 'me', 'us', 'your', 'i', 'we', 'is', 'are', 'was',
  'be', 'been', 'that', 'this', 'these', 'those', 'it', 'its', 'at', 'by',
  'find', 'search', 'show', 'get', 'look', 'looking', 'please', 'where',
  'what', 'which', 'who', 'whose', 'any', 'all', 'some', 'thing', 'things',
]);

const KIND_HINTS: Record<string, OrgSearchKind[]> = {
  project: ['project'],
  projects: ['project'],
  file: ['file'],
  files: ['file'],
  upload: ['file'],
  uploaded: ['file'],
  page: ['page'],
  pages: ['page'],
  wiki: ['page'],
  note: ['page'],
  notes: ['page'],
  app: ['app'],
  apps: ['app'],
  chat: ['chat'],
  message: ['chat'],
  messages: ['chat'],
  invoice: ['record'],
  invoices: ['record'],
  quote: ['record'],
  quotes: ['record'],
  order: ['record'],
  orders: ['record'],
  customer: ['record'],
  customers: ['record'],
  record: ['record'],
  calendar: ['calendar'],
  meeting: ['calendar'],
  event: ['calendar'],
  events: ['calendar'],
  deck: ['file', 'project'],
  slides: ['file', 'project'],
  prototype: ['project', 'file'],
};

const SOURCE_LABEL: Record<OrgSearchKind, string> = {
  project: 'Projects',
  file: 'Files',
  page: 'Pages',
  app: 'Apps',
  chat: 'Team chat',
  record: 'Records',
  calendar: 'Calendar',
};

export interface ParsedSearchQuery {
  phrase: string;
  tokens: string[];
  kindHints: OrgSearchKind[];
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const phrase = raw.trim().toLowerCase();
  const parts = phrase
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const tokens = parts.filter((part) => !STOPWORDS.has(part) && part.length > 1);
  const kindHints: OrgSearchKind[] = [];
  for (const part of parts) {
    const hinted = KIND_HINTS[part];
    if (!hinted) continue;
    for (const kind of hinted) {
      if (!kindHints.includes(kind)) kindHints.push(kind);
    }
  }
  const usable = tokens.length > 0 ? tokens : phrase ? [phrase] : [];
  return { phrase, tokens: usable, kindHints };
}

export function scoreSearchDocument(
  title: string,
  body: string,
  kind: OrgSearchKind,
  ownerName: string | null,
  parsed: ParsedSearchQuery,
): number {
  if (parsed.tokens.length === 0) return 0;
  const titleLc = title.toLowerCase();
  const bodyLc = body.toLowerCase();
  const ownerLc = (ownerName ?? '').toLowerCase();
  let score = 0;
  if (parsed.phrase && titleLc.includes(parsed.phrase)) score += 80;
  else if (parsed.phrase && bodyLc.includes(parsed.phrase)) score += 28;
  for (const token of parsed.tokens) {
    if (titleLc.includes(token)) score += 22;
    else if (bodyLc.includes(token)) score += 8;
    if (ownerLc && ownerLc.includes(token)) score += 18;
  }
  if (parsed.kindHints.includes(kind)) score += 12;
  return score;
}

interface Candidate {
  hit: Omit<OrgSearchHit, 'score'>;
  body: string;
}

function projectInOrg(project: Project, orgId: string): boolean {
  if (!project.orgId) return true;
  return project.orgId === orgId;
}

function isTextualMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return (
    /^text\//i.test(mime) ||
    /^application\/(json|javascript|typescript|xml|x-(?:yaml|toml|httpd-php|sh))\b/i.test(mime) ||
    /\+(?:json|xml)\b/i.test(mime) ||
    /^image\/svg\+xml/i.test(mime)
  );
}

export interface SearchOrganizationInput {
  manager: WorkspaceDbManager;
  projectsDb: Database.Database;
  projectsRoot: string;
  orgId: string;
  viewer: { memberId: string; userId: string; role: OrgRole };
  query: string;
  limit?: number;
}

export async function searchOrganization(input: SearchOrganizationInput): Promise<OrgSearchHit[]> {
  const parsed = parseSearchQuery(input.query);
  if (parsed.tokens.length === 0) return [];

  const directory = input.manager.directoryExecutor;
  const workspace = input.manager.workspaceExecutor(input.orgId);
  const members = await listOrgMembers(directory, input.orgId);
  const visibleIds = visibleMemberIds(members, input.viewer.memberId);
  const visibleUserIds = new Set(
    members.filter((member) => visibleIds.has(member.id)).map((member) => member.userId),
  );
  const nameByMember = new Map(members.map((member) => [member.id, personLabel(member)]));
  const nameByUser = new Map(members.map((member) => [member.userId, personLabel(member)]));
  const inScope = (ownerMemberId: string | null | undefined, ownerUserId?: string | null) =>
    ownerInHierarchyScope(visibleIds, visibleUserIds, ownerMemberId, ownerUserId ?? null);

  const teamIds = await listTeamIdsForMember(directory, input.orgId, input.viewer.memberId);
  const candidates: Candidate[] = [];

  const projects = (listProjects(input.projectsDb) as Project[])
    .filter((project) => projectInOrg(project, input.orgId))
    .filter((project) => inScope(project.createdBy ?? null));

  for (const project of projects) {
    const ownerName = project.createdBy ? (nameByMember.get(project.createdBy) ?? null) : null;
    candidates.push({
      body: `${project.name} ${project.metadata?.kind ?? ''}`,
      hit: {
        kind: 'project',
        id: project.id,
        title: project.name,
        snippet: project.metadata?.kind ?? null,
        href: `/projects/${encodeURIComponent(project.id)}`,
        ownerMemberId: project.createdBy ?? null,
        ownerName,
        sourceLabel: SOURCE_LABEL.project,
        updatedAt: project.updatedAt,
        projectId: project.id,
      },
    });
  }

  for (const project of projects.slice(0, 40)) {
    let files: Array<{ name: string; mime?: string; size?: number; mtime?: number; localPath?: string }> = [];
    try {
      files = await listFiles(input.projectsRoot, project.id, { metadata: project.metadata });
    } catch {
      continue;
    }
    const ownerName = project.createdBy ? (nameByMember.get(project.createdBy) ?? null) : null;
    for (const file of files.slice(0, 80)) {
      let body = `${file.name} ${project.name}`;
      if (isTextualMime(file.mime) && (file.size ?? 0) > 0 && (file.size ?? 0) <= 200_000 && file.localPath) {
        try {
          const content = await readFile(file.localPath, 'utf8');
          body = `${body} ${content.slice(0, 8_000)}`;
        } catch {
          // Unreadable files still match on the name.
        }
      }
      const snippetLine = body
        .split('\n')
        .map((line) => line.trim())
        .find((line) => parsed.tokens.some((token) => line.toLowerCase().includes(token)) && line !== file.name);
      candidates.push({
        body,
        hit: {
          kind: 'file',
          id: `${project.id}:${file.name}`,
          title: file.name,
          snippet: snippetLine ? snippetLine.slice(0, 180) : project.name,
          href: `/projects/${encodeURIComponent(project.id)}/files/${file.name
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`,
          ownerMemberId: project.createdBy ?? null,
          ownerName,
          sourceLabel: SOURCE_LABEL.file,
          updatedAt: Number(file.mtime) || project.updatedAt,
          projectId: project.id,
          fileName: file.name,
        },
      });
    }
  }

  try {
    const pageHits = await searchPages(workspace, input.orgId, parsed.tokens.join(' '), 50);
    const seen = new Set<string>();
    for (const hit of pageHits) {
      if (!inScope(hit.page.createdBy)) continue;
      seen.add(hit.page.id);
      const ownerName = nameByMember.get(hit.page.createdBy) ?? null;
      candidates.push({
        body: `${hit.page.title} ${hit.snippet ?? ''}`,
        hit: {
          kind: 'page',
          id: hit.page.id,
          title: hit.page.title,
          snippet: hit.snippet,
          href: `/pages/${encodeURIComponent(hit.page.id)}`,
          ownerMemberId: hit.page.createdBy,
          ownerName,
          sourceLabel: SOURCE_LABEL.page,
          updatedAt: hit.page.updatedAt,
          pageId: hit.page.id,
        },
      });
    }
    // Titles that the token LIKE missed still need to participate when the
    // person typed a synonym the title itself contains.
    for (const page of await listPages(workspace, input.orgId)) {
      if (seen.has(page.id) || !inScope(page.createdBy)) continue;
      candidates.push({
        body: page.title,
        hit: {
          kind: 'page',
          id: page.id,
          title: page.title,
          snippet: null,
          href: `/pages/${encodeURIComponent(page.id)}`,
          ownerMemberId: page.createdBy,
          ownerName: nameByMember.get(page.createdBy) ?? null,
          sourceLabel: SOURCE_LABEL.page,
          updatedAt: page.updatedAt,
          pageId: page.id,
        },
      });
    }
  } catch {
    // Pages table may not exist on a brand-new org.
  }

  try {
    const apps = await listApps(workspace, input.orgId, {
      viewerMemberId: input.viewer.memberId,
      viewerRole: input.viewer.role,
      viewerTeamIds: teamIds,
      resolveMemberName: (id) => nameByMember.get(id) ?? null,
    });
    for (const app of apps as OrgApp[]) {
      if (!inScope(app.createdBy)) continue;
      candidates.push({
        body: `${app.name} ${app.description ?? ''}`,
        hit: {
          kind: 'app',
          id: app.id,
          title: app.name,
          snippet: app.description,
          href: '/apps',
          ownerMemberId: app.createdBy,
          ownerName: app.createdByName ?? nameByMember.get(app.createdBy) ?? null,
          sourceLabel: SOURCE_LABEL.app,
          updatedAt: app.updatedAt,
          appId: app.id,
          projectId: app.projectId,
          fileName: app.filePath,
        },
      });
    }
  } catch {
    // Apps are optional on a fresh org.
  }

  try {
    const chatHits = await searchMessages(
      workspace,
      input.orgId,
      input.viewer.memberId,
      parsed.tokens.join(' '),
      (id) => nameByMember.get(id) ?? null,
    );
    for (const hit of chatHits) {
      if (!inScope(hit.message.authorMemberId)) continue;
      candidates.push({
        body: `${hit.channelName} ${hit.message.body}`,
        hit: {
          kind: 'chat',
          id: hit.message.id,
          title: hit.channelName || 'Chat',
          snippet: hit.message.body.slice(0, 180),
          href: `/team/${encodeURIComponent(hit.channelId)}`,
          ownerMemberId: hit.message.authorMemberId,
          ownerName: hit.message.authorName,
          sourceLabel: SOURCE_LABEL.chat,
          updatedAt: hit.message.createdAt,
          channelId: hit.channelId,
        },
      });
    }
  } catch {
    // Chat is optional.
  }

  try {
    const events = await listCalendarEvents(workspace, input.orgId);
    for (const event of events) {
      if (!inScope(null, event.createdBy)) continue;
      candidates.push({
        body: `${event.title} ${event.description ?? ''} ${event.location ?? ''}`,
        hit: {
          kind: 'calendar',
          id: event.id,
          title: event.title,
          snippet: event.description ?? event.location,
          href: '/calendar',
          ownerMemberId: members.find((member) => member.userId === event.createdBy)?.id ?? null,
          ownerName: nameByUser.get(event.createdBy) ?? null,
          sourceLabel: SOURCE_LABEL.calendar,
          updatedAt: event.updatedAt,
          eventId: event.id,
        },
      });
    }
  } catch {
    // Calendar is optional.
  }

  try {
    await collectErpRecords(workspace, input.orgId, inScope, nameByMember, candidates);
  } catch {
    // ERP tables are sqlite-file scoped and may be absent.
  }

  const ranked: OrgSearchHit[] = [];
  for (const candidate of candidates) {
    const score = scoreSearchDocument(
      candidate.hit.title,
      candidate.body,
      candidate.hit.kind,
      candidate.hit.ownerName,
      parsed,
    );
    if (score <= 0) continue;
    ranked.push({ ...candidate.hit, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  const cap = Math.min(50, Math.max(1, input.limit ?? 25));
  return ranked.slice(0, cap);
}

async function collectErpRecords(
  db: SqlExecutor,
  orgId: string,
  inScope: (ownerMemberId: string | null | undefined, ownerUserId?: string | null) => boolean,
  nameByMember: Map<string, string>,
  candidates: Candidate[],
): Promise<void> {
  void orgId;
  const tables = await db.all<{ id: string; name: string; displayName: string }>(
    `SELECT id, name, display_name AS "displayName" FROM od_tables WHERE status = 'active'`,
  );
  if (tables.length === 0) return;
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const rows = await db.all<{
    id: string;
    tableId: string;
    dataJson: string;
    createdById: string | null;
    updatedAt: number | string;
  }>(
    `SELECT id, table_id AS "tableId", data_json AS "dataJson",
            created_by_id AS "createdById", updated_at AS "updatedAt"
       FROM od_records
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 400`,
  );
  for (const row of rows) {
    if (!inScope(row.createdById)) continue;
    const table = tableById.get(row.tableId);
    if (!table) continue;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.dataJson) as Record<string, unknown>;
    } catch {
      data = {};
    }
    const label =
      (typeof data.name === 'string' && data.name) ||
      (typeof data.title === 'string' && data.title) ||
      (typeof data.invoice_number === 'string' && data.invoice_number) ||
      `${table.displayName} record`;
    const body = Object.values(data)
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .join(' ');
    candidates.push({
      body: `${label} ${body} ${table.displayName} ${table.name}`,
      hit: {
        kind: 'record',
        id: row.id,
        title: String(label),
        snippet: table.displayName,
        href: '/',
        ownerMemberId: row.createdById,
        ownerName: row.createdById ? (nameByMember.get(row.createdById) ?? null) : null,
        sourceLabel: SOURCE_LABEL.record,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Number(row.updatedAt),
        tableName: table.name,
        recordId: row.id,
      },
    });
  }
}

