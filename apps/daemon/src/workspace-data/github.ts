// Live GitHub through Composio. Repos, PRs, and issues stay on GitHub —
// we never copy them into the org database. Parsing is defensive because
// Composio wraps GitHub payloads in a few envelopes depending on the tool.

import type {
  GithubComment,
  GithubCommit,
  GithubIssue,
  GithubNotification,
  GithubProfile,
  GithubPullRequest,
  GithubRepo,
  GithubUserRef,
  GithubWorkflowRun,
} from '@open-design/contracts';
import type { BoundedJsonObject } from '../live-artifacts/schema.js';
import { composioConnectorProvider } from '../connectors/composio.js';
import type { ConnectorCredentialMaterial } from '../connectors/service.js';
import { WorkspaceDataError } from './errors.js';

export const GITHUB_CONNECTOR_ID = 'github';

export interface GithubExecutor {
  execute(toolName: string, input: Record<string, unknown>, sideEffect: 'read' | 'write'): Promise<unknown>;
}

function githubTool(name: string, sideEffect: 'read' | 'write') {
  return {
    name,
    providerToolId: name,
    description: name,
    inputSchema: { type: 'object' },
    safety: {
      sideEffect,
      approval: sideEffect === 'read' ? 'auto' : 'confirm',
      reason: 'github',
    },
  } as never;
}

export function createGithubExecutor(
  credentials: ConnectorCredentialMaterial | undefined,
): GithubExecutor {
  return {
    async execute(toolName, input, sideEffect) {
      return composioConnectorProvider.execute(
        { id: GITHUB_CONNECTOR_ID } as never,
        githubTool(toolName, sideEffect),
        input as BoundedJsonObject,
        credentials,
      );
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function unwrapData(value: unknown): unknown {
  let current = parseMaybeJson(value);
  for (let i = 0; i < 6; i += 1) {
    const rec = asRecord(current);
    if (!rec) return current;
    const nested =
      rec.data
      ?? rec.response_data
      ?? rec.response
      ?? rec.result
      ?? rec.successful
      ?? rec.payload;
    if (nested === undefined || nested === current) return current;
    current = parseMaybeJson(nested);
  }
  return current;
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numberField(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function boolField(rec: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = rec[key];
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
  }
  return false;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of [
    'items', 'repositories', 'repos', 'pulls', 'pull_requests', 'issues',
    'commits', 'comments', 'workflow_runs', 'notifications', 'results', 'data',
  ]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

function githubFailure(err: unknown, fallback: string): never {
  const message = err instanceof Error ? err.message : fallback;
  throw new WorkspaceDataError('CONNECTOR_EXECUTION_FAILED', 502, message);
}

function isMissingTool(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|unknown tool|does not exist|no such tool|404/i.test(message);
}

async function executeFirst(
  exec: GithubExecutor,
  names: string[],
  input: Record<string, unknown>,
  sideEffect: 'read' | 'write',
): Promise<unknown> {
  let last: unknown;
  for (const name of names) {
    try {
      return await exec.execute(name, input, sideEffect);
    } catch (err) {
      last = err;
      if (!isMissingTool(err)) githubFailure(err, `GitHub tool ${name} failed`);
    }
  }
  githubFailure(last, `GitHub tools unavailable: ${names.join(', ')}`);
}

function repoInput(owner: string, repo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner, repo, repository: repo, ...extra };
}

function requireOwnerRepo(owner: string, repo: string): { owner: string; repo: string } {
  const o = owner.trim();
  const r = repo.trim();
  if (!o || !r) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'owner and repo are required');
  }
  return { owner: o, repo: r };
}

function userRef(value: unknown): GithubUserRef | null {
  if (typeof value === 'string' && value.trim()) return { login: value.trim(), avatarUrl: null };
  const rec = asRecord(value);
  if (!rec) return null;
  const login = stringField(rec, 'login', 'username', 'name');
  if (!login) return null;
  return { login, avatarUrl: stringField(rec, 'avatar_url', 'avatarUrl', 'avatar') };
}

function ownerLogin(value: unknown): string | null {
  if (typeof value === 'string' && value.includes('/')) return value.split('/')[0] ?? null;
  if (typeof value === 'string') return value.trim() || null;
  const rec = asRecord(value);
  if (!rec) return null;
  return stringField(rec, 'login', 'name', 'username');
}

export function extractGithubProfile(payload: unknown): GithubProfile | null {
  const rec = asRecord(unwrapData(payload)) ?? asRecord(payload);
  if (!rec) return null;
  const login = stringField(rec, 'login', 'username', 'user');
  if (!login) return null;
  return {
    login,
    name: stringField(rec, 'name', 'display_name', 'displayName'),
    avatarUrl: stringField(rec, 'avatar_url', 'avatarUrl', 'avatar'),
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url'),
  };
}

export function normalizeGithubRepo(value: unknown): GithubRepo | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const name = stringField(rec, 'name', 'repo', 'repository');
  const ownerFromField = ownerLogin(rec.owner);
  const fullName = stringField(rec, 'full_name', 'fullName');
  const owner = ownerFromField ?? (fullName?.includes('/') ? fullName.split('/')[0] ?? null : null);
  const resolvedName = name ?? (fullName?.includes('/') ? fullName.split('/')[1] ?? null : null);
  if (!resolvedName || !owner) return null;
  const id = stringField(rec, 'id', 'node_id') ?? `${owner}/${resolvedName}`;
  return {
    id: String(id),
    owner,
    name: resolvedName,
    fullName: fullName ?? `${owner}/${resolvedName}`,
    description: stringField(rec, 'description'),
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url') ?? `https://github.com/${owner}/${resolvedName}`,
    private: boolField(rec, 'private', 'isPrivate', 'is_private'),
    fork: boolField(rec, 'fork', 'isFork', 'is_fork'),
    language: stringField(rec, 'language'),
    stars: numberField(rec, 'stargazers_count', 'stars', 'stargazers') ?? 0,
    forks: numberField(rec, 'forks_count', 'forks') ?? 0,
    openIssues: numberField(rec, 'open_issues_count', 'open_issues', 'openIssues') ?? 0,
    defaultBranch: stringField(rec, 'default_branch', 'defaultBranch') ?? 'main',
    pushedAt: stringField(rec, 'pushed_at', 'pushedAt'),
    updatedAt: stringField(rec, 'updated_at', 'updatedAt'),
  };
}

export function extractGithubRepos(payload: unknown): GithubRepo[] {
  const root = unwrapData(payload);
  const out: GithubRepo[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const repo = normalizeGithubRepo(raw);
    if (!repo || seen.has(repo.fullName)) continue;
    seen.add(repo.fullName);
    out.push(repo);
  }
  if (out.length === 0) {
    const single = normalizeGithubRepo(root);
    if (single) out.push(single);
  }
  return out;
}

function pullState(rec: Record<string, unknown>): GithubPullRequest['state'] {
  if (stringField(rec, 'merged_at', 'mergedAt') || boolField(rec, 'merged')) return 'merged';
  const state = (stringField(rec, 'state') ?? 'open').toLowerCase();
  if (state === 'closed' || state === 'merged') return state;
  return 'open';
}

export function normalizeGithubPull(value: unknown): GithubPullRequest | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const number = numberField(rec, 'number', 'pull_number', 'issue_number');
  const title = stringField(rec, 'title');
  if (number == null || !title) return null;
  const head = asRecord(rec.head);
  const base = asRecord(rec.base);
  return {
    id: String(stringField(rec, 'id', 'node_id') ?? number),
    number,
    title,
    body: stringField(rec, 'body', 'body_text'),
    state: pullState(rec),
    draft: boolField(rec, 'draft', 'is_draft', 'isDraft'),
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url') ?? '',
    user: userRef(rec.user ?? rec.author),
    head: stringField(head ?? {}, 'ref', 'label') ?? stringField(rec, 'head', 'head_ref'),
    base: stringField(base ?? {}, 'ref', 'label') ?? stringField(rec, 'base', 'base_ref'),
    createdAt: stringField(rec, 'created_at', 'createdAt'),
    updatedAt: stringField(rec, 'updated_at', 'updatedAt'),
    mergedAt: stringField(rec, 'merged_at', 'mergedAt'),
    comments: numberField(rec, 'comments', 'review_comments') ?? 0,
    additions: numberField(rec, 'additions'),
    deletions: numberField(rec, 'deletions'),
    changedFiles: numberField(rec, 'changed_files', 'changedFiles'),
  };
}

export function extractGithubPulls(payload: unknown): GithubPullRequest[] {
  const root = unwrapData(payload);
  const out: GithubPullRequest[] = [];
  const seen = new Set<number>();
  for (const raw of asList(root)) {
    const pull = normalizeGithubPull(raw);
    if (!pull || seen.has(pull.number)) continue;
    seen.add(pull.number);
    out.push(pull);
  }
  if (out.length === 0) {
    const single = normalizeGithubPull(root);
    if (single) out.push(single);
  }
  return out;
}

export function normalizeGithubIssue(value: unknown): GithubIssue | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const number = numberField(rec, 'number', 'issue_number');
  const title = stringField(rec, 'title');
  if (number == null || !title) return null;
  const labels = Array.isArray(rec.labels)
    ? rec.labels.flatMap((item) => {
      if (typeof item === 'string') return [item];
      const label = asRecord(item);
      const name = label ? stringField(label, 'name') : null;
      return name ? [name] : [];
    })
    : [];
  const state = (stringField(rec, 'state') ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open';
  return {
    id: String(stringField(rec, 'id', 'node_id') ?? number),
    number,
    title,
    body: stringField(rec, 'body', 'body_text'),
    state,
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url') ?? '',
    user: userRef(rec.user ?? rec.author),
    comments: numberField(rec, 'comments') ?? 0,
    labels,
    pullRequest: Boolean(rec.pull_request) || Boolean(rec.pullRequest),
    createdAt: stringField(rec, 'created_at', 'createdAt'),
    updatedAt: stringField(rec, 'updated_at', 'updatedAt'),
  };
}

export function extractGithubIssues(payload: unknown): GithubIssue[] {
  const root = unwrapData(payload);
  const out: GithubIssue[] = [];
  const seen = new Set<number>();
  for (const raw of asList(root)) {
    const issue = normalizeGithubIssue(raw);
    if (!issue || issue.pullRequest || seen.has(issue.number)) continue;
    seen.add(issue.number);
    out.push(issue);
  }
  if (out.length === 0) {
    const single = normalizeGithubIssue(root);
    if (single && !single.pullRequest) out.push(single);
  }
  return out;
}

export function normalizeGithubCommit(value: unknown): GithubCommit | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const sha = stringField(rec, 'sha', 'id', 'commit_sha');
  const commit = asRecord(rec.commit) ?? rec;
  const message = stringField(commit, 'message') ?? stringField(rec, 'message');
  if (!sha || !message) return null;
  const authorRec = asRecord(commit.author) ?? asRecord(rec.author);
  return {
    sha,
    message: message.split('\n')[0] ?? message,
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url') ?? '',
    author: stringField(authorRec ?? {}, 'login', 'name') ?? stringField(rec, 'author'),
    date: stringField(authorRec ?? {}, 'date') ?? stringField(commit, 'date'),
  };
}

export function extractGithubCommits(payload: unknown): GithubCommit[] {
  const root = unwrapData(payload);
  const out: GithubCommit[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const commit = normalizeGithubCommit(raw);
    if (!commit || seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    out.push(commit);
  }
  return out;
}

export function normalizeGithubWorkflowRun(value: unknown): GithubWorkflowRun | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const numericId = numberField(rec, 'id');
  const id = stringField(rec, 'id') ?? (numericId != null ? String(numericId) : null);
  if (!id) return null;
  return {
    id,
    name: stringField(rec, 'name', 'display_title', 'displayTitle') ?? 'Workflow',
    status: stringField(rec, 'status') ?? 'unknown',
    conclusion: stringField(rec, 'conclusion'),
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl', 'url') ?? '',
    headBranch: stringField(rec, 'head_branch', 'headBranch', 'branch'),
    event: stringField(rec, 'event'),
    createdAt: stringField(rec, 'created_at', 'createdAt'),
  };
}

export function extractGithubWorkflowRuns(payload: unknown): GithubWorkflowRun[] {
  const root = unwrapData(payload);
  const out: GithubWorkflowRun[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const run = normalizeGithubWorkflowRun(raw);
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    out.push(run);
  }
  return out;
}

export function normalizeGithubNotification(value: unknown): GithubNotification | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const id = stringField(rec, 'id');
  const subject = asRecord(rec.subject) ?? rec;
  const title = stringField(subject, 'title') ?? stringField(rec, 'title');
  if (!id || !title) return null;
  const repo = asRecord(rec.repository);
  return {
    id,
    title,
    reason: stringField(rec, 'reason') ?? '',
    repository: stringField(repo ?? {}, 'full_name', 'fullName')
      ?? stringField(rec, 'repository', 'repo')
      ?? '',
    htmlUrl: stringField(subject, 'url', 'html_url') ?? stringField(rec, 'html_url', 'htmlUrl'),
    unread: rec.unread !== false,
    updatedAt: stringField(rec, 'updated_at', 'updatedAt'),
  };
}

export function extractGithubNotifications(payload: unknown): GithubNotification[] {
  const root = unwrapData(payload);
  const out: GithubNotification[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const item = normalizeGithubNotification(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function normalizeGithubComment(value: unknown): GithubComment | null {
  const rec = asRecord(parseMaybeJson(value));
  if (!rec) return null;
  const body = stringField(rec, 'body');
  if (!body) return null;
  return {
    id: String(stringField(rec, 'id') ?? numberField(rec, 'id') ?? body.slice(0, 12)),
    body,
    user: userRef(rec.user ?? rec.author),
    htmlUrl: stringField(rec, 'html_url', 'htmlUrl'),
    createdAt: stringField(rec, 'created_at', 'createdAt'),
  };
}

export function extractGithubComments(payload: unknown): GithubComment[] {
  const root = unwrapData(payload);
  const out: GithubComment[] = [];
  const seen = new Set<string>();
  for (const raw of asList(root)) {
    const comment = normalizeGithubComment(raw);
    if (!comment || seen.has(comment.id)) continue;
    seen.add(comment.id);
    out.push(comment);
  }
  return out;
}

const PROFILE_TOOLS = [
  'GITHUB_GET_THE_AUTHENTICATED_USER',
  'GITHUB_GET_AUTHENTICATED_USER',
  'GITHUB_GET_A_USER',
];
const LIST_REPO_TOOLS = [
  'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_LIST_REPOS_FOR_AUTHENTICATED_USER',
  'GITHUB_LIST_REPOSITORIES_FOR_A_USER',
];
const SEARCH_REPO_TOOLS = ['GITHUB_SEARCH_REPOSITORIES', 'GITHUB_SEARCH_REPOS'];
const GET_REPO_TOOLS = ['GITHUB_GET_A_REPOSITORY', 'GITHUB_GET_REPOSITORY'];
const LIST_PULL_TOOLS = ['GITHUB_LIST_PULL_REQUESTS', 'GITHUB_LIST_PULLS'];
const GET_PULL_TOOLS = ['GITHUB_GET_A_PULL_REQUEST', 'GITHUB_GET_PULL_REQUEST'];
const LIST_ISSUE_TOOLS = ['GITHUB_LIST_REPOSITORY_ISSUES', 'GITHUB_LIST_ISSUES'];
const GET_ISSUE_TOOLS = ['GITHUB_GET_AN_ISSUE', 'GITHUB_GET_ISSUE'];
const CREATE_ISSUE_TOOLS = ['GITHUB_CREATE_AN_ISSUE', 'GITHUB_CREATE_ISSUE'];
const COMMENT_TOOLS = ['GITHUB_CREATE_AN_ISSUE_COMMENT', 'GITHUB_CREATE_ISSUE_COMMENT'];
const MERGE_TOOLS = ['GITHUB_MERGE_A_PULL_REQUEST', 'GITHUB_MERGE_PULL_REQUEST'];
const COMMIT_TOOLS = ['GITHUB_LIST_COMMITS'];
const ACTION_TOOLS = [
  'GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY',
  'GITHUB_LIST_WORKFLOW_RUNS',
];
const NOTIFICATION_TOOLS = [
  'GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER',
  'GITHUB_LIST_NOTIFICATIONS',
];
const STAR_TOOLS = ['GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER', 'GITHUB_STAR_REPO'];
const LIST_COMMENT_TOOLS = [
  'GITHUB_LIST_ISSUE_COMMENTS',
  'GITHUB_LIST_COMMENTS_ON_AN_ISSUE',
];

export async function fetchGithubProfile(exec: GithubExecutor): Promise<GithubProfile | null> {
  try {
    return extractGithubProfile(await executeFirst(exec, PROFILE_TOOLS, {}, 'read'));
  } catch {
    return null;
  }
}

export async function listGithubRepos(
  exec: GithubExecutor,
  options?: { query?: string },
): Promise<GithubRepo[]> {
  const query = options?.query?.trim();
  try {
    if (query) {
      return extractGithubRepos(
        await executeFirst(exec, SEARCH_REPO_TOOLS, { query, q: query }, 'read'),
      );
    }
    return extractGithubRepos(
      await executeFirst(exec, LIST_REPO_TOOLS, {
        per_page: 50,
        sort: 'updated',
        affiliation: 'owner,collaborator,organization_member',
      }, 'read'),
    );
  } catch (err) {
    githubFailure(err, 'Could not list GitHub repositories');
  }
}

export async function getGithubRepo(
  exec: GithubExecutor,
  owner: string,
  repo: string,
): Promise<GithubRepo | null> {
  const target = requireOwnerRepo(owner, repo);
  try {
    const listed = extractGithubRepos(
      await executeFirst(exec, GET_REPO_TOOLS, repoInput(target.owner, target.repo), 'read'),
    );
    return listed[0] ?? null;
  } catch (err) {
    githubFailure(err, 'Could not load GitHub repository');
  }
}

export async function listGithubPulls(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  state = 'open',
): Promise<GithubPullRequest[]> {
  const target = requireOwnerRepo(owner, repo);
  try {
    return extractGithubPulls(
      await executeFirst(exec, LIST_PULL_TOOLS, repoInput(target.owner, target.repo, { state }), 'read'),
    );
  } catch (err) {
    githubFailure(err, 'Could not list pull requests');
  }
}

export async function getGithubPull(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  number: number,
): Promise<GithubPullRequest | null> {
  const target = requireOwnerRepo(owner, repo);
  try {
    const listed = extractGithubPulls(
      await executeFirst(
        exec,
        GET_PULL_TOOLS,
        repoInput(target.owner, target.repo, { pull_number: number, number }),
        'read',
      ),
    );
    return listed[0] ?? null;
  } catch (err) {
    githubFailure(err, 'Could not load pull request');
  }
}

export async function listGithubIssues(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  state = 'open',
): Promise<GithubIssue[]> {
  const target = requireOwnerRepo(owner, repo);
  try {
    return extractGithubIssues(
      await executeFirst(exec, LIST_ISSUE_TOOLS, repoInput(target.owner, target.repo, { state }), 'read'),
    );
  } catch (err) {
    githubFailure(err, 'Could not list issues');
  }
}

export async function getGithubIssue(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  number: number,
): Promise<GithubIssue | null> {
  const target = requireOwnerRepo(owner, repo);
  try {
    const listed = extractGithubIssues(
      await executeFirst(
        exec,
        GET_ISSUE_TOOLS,
        repoInput(target.owner, target.repo, { issue_number: number, number }),
        'read',
      ),
    );
    return listed[0] ?? null;
  } catch (err) {
    githubFailure(err, 'Could not load issue');
  }
}

export async function createGithubIssue(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  title: string,
  body?: string,
): Promise<GithubIssue | null> {
  const target = requireOwnerRepo(owner, repo);
  const trimmed = title.trim();
  if (!trimmed) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'title is required');
  }
  try {
    const listed = extractGithubIssues(
      await executeFirst(
        exec,
        CREATE_ISSUE_TOOLS,
        repoInput(target.owner, target.repo, { title: trimmed, body: body?.trim() ?? '' }),
        'write',
      ),
    );
    return listed[0] ?? null;
  } catch (err) {
    githubFailure(err, 'Could not create issue');
  }
}

export async function listGithubComments(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  number: number,
): Promise<GithubComment[]> {
  const target = requireOwnerRepo(owner, repo);
  try {
    return extractGithubComments(
      await executeFirst(
        exec,
        LIST_COMMENT_TOOLS,
        repoInput(target.owner, target.repo, { issue_number: number, number }),
        'read',
      ),
    );
  } catch {
    return [];
  }
}

export async function commentGithubIssue(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<GithubComment | null> {
  const target = requireOwnerRepo(owner, repo);
  const trimmed = body.trim();
  if (!trimmed) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'body is required');
  }
  try {
    const listed = extractGithubComments(
      await executeFirst(
        exec,
        COMMENT_TOOLS,
        repoInput(target.owner, target.repo, {
          issue_number: number,
          number,
          body: trimmed,
        }),
        'write',
      ),
    );
    return listed[0] ?? { id: 'new', body: trimmed, user: null, htmlUrl: null, createdAt: null };
  } catch (err) {
    githubFailure(err, 'Could not comment');
  }
}

export async function mergeGithubPull(
  exec: GithubExecutor,
  owner: string,
  repo: string,
  number: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
): Promise<GithubPullRequest | null> {
  const target = requireOwnerRepo(owner, repo);
  try {
    const listed = extractGithubPulls(
      await executeFirst(
        exec,
        MERGE_TOOLS,
        repoInput(target.owner, target.repo, {
          pull_number: number,
          number,
          merge_method: method,
        }),
        'write',
      ),
    );
    return listed[0] ?? null;
  } catch (err) {
    githubFailure(err, 'Could not merge pull request');
  }
}

export async function listGithubCommits(
  exec: GithubExecutor,
  owner: string,
  repo: string,
): Promise<GithubCommit[]> {
  const target = requireOwnerRepo(owner, repo);
  try {
    return extractGithubCommits(
      await executeFirst(exec, COMMIT_TOOLS, repoInput(target.owner, target.repo, { per_page: 30 }), 'read'),
    );
  } catch (err) {
    githubFailure(err, 'Could not list commits');
  }
}

export async function listGithubWorkflowRuns(
  exec: GithubExecutor,
  owner: string,
  repo: string,
): Promise<GithubWorkflowRun[]> {
  const target = requireOwnerRepo(owner, repo);
  try {
    return extractGithubWorkflowRuns(
      await executeFirst(exec, ACTION_TOOLS, repoInput(target.owner, target.repo, { per_page: 20 }), 'read'),
    );
  } catch (err) {
    githubFailure(err, 'Could not list workflow runs');
  }
}

export async function listGithubNotifications(exec: GithubExecutor): Promise<GithubNotification[]> {
  try {
    return extractGithubNotifications(
      await executeFirst(exec, NOTIFICATION_TOOLS, { all: false, per_page: 30 }, 'read'),
    );
  } catch {
    return [];
  }
}

export async function starGithubRepo(
  exec: GithubExecutor,
  owner: string,
  repo: string,
): Promise<void> {
  const target = requireOwnerRepo(owner, repo);
  try {
    await executeFirst(exec, STAR_TOOLS, repoInput(target.owner, target.repo), 'write');
  } catch (err) {
    githubFailure(err, 'Could not star repository');
  }
}
