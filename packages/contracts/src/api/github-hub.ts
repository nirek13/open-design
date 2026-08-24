/** Live GitHub client — data stays on GitHub; the daemon is a Composio proxy. */

export interface GithubProfile {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

export interface GithubRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  defaultBranch: string;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface GithubUserRef {
  login: string;
  avatarUrl: string | null;
}

export interface GithubPullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  htmlUrl: string;
  user: GithubUserRef | null;
  head: string | null;
  base: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  comments: number;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface GithubIssue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  htmlUrl: string;
  user: GithubUserRef | null;
  comments: number;
  labels: string[];
  pullRequest: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GithubCommit {
  sha: string;
  message: string;
  htmlUrl: string;
  author: string | null;
  date: string | null;
}

export interface GithubWorkflowRun {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headBranch: string | null;
  event: string | null;
  createdAt: string | null;
}

export interface GithubNotification {
  id: string;
  title: string;
  reason: string;
  repository: string;
  htmlUrl: string | null;
  unread: boolean;
  updatedAt: string | null;
}

export interface GithubComment {
  id: string;
  body: string;
  user: GithubUserRef | null;
  htmlUrl: string | null;
  createdAt: string | null;
}

export interface GithubStatusResponse {
  connected: boolean;
  profile: GithubProfile | null;
}

export interface GithubReposResponse {
  connected: boolean;
  profile: GithubProfile | null;
  repos: GithubRepo[];
}

export interface GithubRepoDetailResponse {
  repo: GithubRepo | null;
  pulls: GithubPullRequest[];
  issues: GithubIssue[];
  commits: GithubCommit[];
  workflowRuns: GithubWorkflowRun[];
}

export interface GithubPullDetailResponse {
  pull: GithubPullRequest | null;
  comments: GithubComment[];
}

export interface GithubIssueDetailResponse {
  issue: GithubIssue | null;
  comments: GithubComment[];
}

export interface GithubNotificationsResponse {
  connected: boolean;
  notifications: GithubNotification[];
}

export interface CreateGithubIssueRequest {
  title: string;
  body?: string;
}

export interface CommentGithubIssueRequest {
  body: string;
}

export interface MergeGithubPullRequest {
  method?: 'merge' | 'squash' | 'rebase';
}
