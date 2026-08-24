import { describe, expect, it } from 'vitest';

import {
  extractGithubComments,
  extractGithubCommits,
  extractGithubIssues,
  extractGithubNotifications,
  extractGithubProfile,
  extractGithubPulls,
  extractGithubRepos,
  extractGithubWorkflowRuns,
} from '../src/workspace-data/github.js';

const REPO = {
  id: 1,
  name: 'open-design',
  full_name: 'nexu-io/open-design',
  owner: { login: 'nexu-io', avatar_url: 'https://avatars.example/nexu' },
  description: 'Design agent workspace',
  html_url: 'https://github.com/nexu-io/open-design',
  private: false,
  fork: false,
  language: 'TypeScript',
  stargazers_count: 42,
  forks_count: 7,
  open_issues_count: 3,
  default_branch: 'main',
  pushed_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
};

describe('github payload parsing', () => {
  it('unwraps Composio envelopes for the authenticated user and repos', () => {
    expect(extractGithubProfile({
      data: { login: 'ada', name: 'Ada Lovelace', avatar_url: 'https://avatars.example/ada', html_url: 'https://github.com/ada' },
    })).toMatchObject({ login: 'ada', name: 'Ada Lovelace' });

    const repos = extractGithubRepos({
      successful: true,
      data: { items: [REPO] },
    });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      owner: 'nexu-io',
      name: 'open-design',
      fullName: 'nexu-io/open-design',
      stars: 42,
      language: 'TypeScript',
    });
  });

  it('normalizes pull requests, issues, and filters PR-shaped issues', () => {
    const pulls = extractGithubPulls({
      data: [{
        id: 9,
        number: 12,
        title: 'Add GitHub hub',
        body: 'Ship /dev',
        state: 'open',
        draft: false,
        html_url: 'https://github.com/nexu-io/open-design/pull/12',
        user: { login: 'ada' },
        head: { ref: 'feat/dev' },
        base: { ref: 'main' },
        merged_at: null,
        comments: 2,
      }],
    });
    expect(pulls[0]).toMatchObject({
      number: 12,
      state: 'open',
      head: 'feat/dev',
      base: 'main',
    });

    const issues = extractGithubIssues({
      data: [
        { number: 4, title: 'Bug', state: 'open', html_url: 'https://github.com/x/y/issues/4', user: { login: 'ada' }, labels: [{ name: 'bug' }] },
        { number: 12, title: 'Add GitHub hub', state: 'open', html_url: 'https://github.com/x/y/pull/12', pull_request: { url: 'https://api.github.com/repos/x/y/pulls/12' } },
      ],
    });
    expect(issues.map((issue) => issue.number)).toEqual([4]);
    expect(issues[0]?.labels).toEqual(['bug']);
  });

  it('reads commits, workflow runs, notifications, and comments', () => {
    const commits = extractGithubCommits({
      data: [{
        sha: 'abc1234',
        html_url: 'https://github.com/x/y/commit/abc1234',
        commit: { message: 'fix: parser\n\nDetails', author: { name: 'Ada', date: '2026-08-02T00:00:00Z' } },
      }],
    });
    expect(commits[0]).toMatchObject({ sha: 'abc1234', message: 'fix: parser', author: 'Ada' });

    const runs = extractGithubWorkflowRuns({
      workflow_runs: [{
        id: 88,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/x/y/actions/runs/88',
        head_branch: 'main',
        event: 'push',
      }],
    });
    expect(runs[0]).toMatchObject({ id: '88', conclusion: 'success' });

    const notes = extractGithubNotifications({
      data: [{
        id: 'n1',
        unread: true,
        reason: 'review_requested',
        updated_at: '2026-08-02T00:00:00Z',
        subject: { title: 'Please review', url: 'https://api.github.com/repos/x/y/pulls/12' },
        repository: { full_name: 'nexu-io/open-design' },
      }],
    });
    expect(notes[0]).toMatchObject({
      title: 'Please review',
      repository: 'nexu-io/open-design',
      unread: true,
    });

    const comments = extractGithubComments({
      data: [{ id: 5, body: 'LGTM', user: { login: 'ada' }, html_url: 'https://github.com/x/y/issues/4#issuecomment-5' }],
    });
    expect(comments[0]).toMatchObject({ body: 'LGTM', user: { login: 'ada' } });
  });
});
