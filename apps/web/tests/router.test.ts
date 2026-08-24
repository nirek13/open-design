/**
 * URL router round-trip tests (issue #1505).
 *
 * Pins the deep-link shape for the project route:
 *
 *   /                                                 home
 *   /projects/:id                                     project root
 *   /projects/:id/files/:path                         file view
 *   /projects/:id/conversations/:cid                  specific conversation
 *   /projects/:id/conversations/:cid/files/:path      conversation + file
 *
 * The conversation segment was added to unblock the Routines history
 * row: clicking "Open project" on a parallel run's row needs to land
 * the user on that run's own conversation, not on whatever the
 * project happens to default to.
 */

import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute, type Route } from '../src/router';

function roundTrip(route: Route): Route {
  return parseRoute(buildPath(route));
}

describe('parseRoute / buildPath (issue #1505)', () => {
  it('parses the home route', () => {
    // The workspace is the landing surface; the agent hero lives at /home.
    expect(parseRoute('/')).toEqual({ kind: 'home', view: 'workspace' });
    expect(parseRoute('')).toEqual({ kind: 'home', view: 'workspace' });
    expect(parseRoute('/home')).toEqual({ kind: 'home', view: 'home' });
  });

  it('round-trips ERP connections', () => {
    const route: Route = { kind: 'home', view: 'connections' };
    expect(parseRoute('/erp/connections')).toEqual(route);
    expect(parseRoute('/connections')).toEqual(route);
    expect(buildPath(route)).toBe('/erp/connections');
  });

  it('round-trips a bare project route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1');
  });

  it('round-trips a project + file route (no conversation)', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'src/index.tsx',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/files/src/index.tsx');
  });

  it('round-trips a project + conversation route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: null,
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc');
  });

  it('round-trips a project + conversation + file route', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'conv-abc',
      fileName: 'index.html',
    };
    expect(roundTrip(route)).toEqual(route);
    expect(buildPath(route)).toBe('/projects/p-1/conversations/conv-abc/files/index.html');
  });

  it('percent-encodes ids and file names with reserved characters', () => {
    const route: Route = {
      kind: 'project',
      projectId: 'p/1 with space',
      conversationId: 'conv/abc with space',
      fileName: 'dir/file name.tsx',
    };
    const built = buildPath(route);
    expect(built).toContain('p%2F1%20with%20space');
    expect(built).toContain('conv%2Fabc%20with%20space');
    // File path components are percent-encoded individually so the
    // slash between segments survives.
    expect(built.endsWith('/dir/file%20name.tsx')).toBe(true);
    expect(roundTrip(route)).toEqual(route);
  });

  it('parses a legacy project + file URL with no conversation segment', () => {
    expect(parseRoute('/projects/p-1/files/README.md')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: null,
      fileName: 'README.md',
    });
  });

  it('parses a project + conversation URL with no file segment', () => {
    expect(parseRoute('/projects/p-1/conversations/c-2')).toEqual({
      kind: 'project',
      projectId: 'p-1',
      conversationId: 'c-2',
      fileName: null,
    });
  });

  it('round-trips mail and a mail thread', () => {
    const inbox: Route = { kind: 'home', view: 'mail' };
    expect(parseRoute('/mail')).toEqual(inbox);
    expect(buildPath(inbox)).toBe('/mail');
    const thread: Route = { kind: 'home', view: 'mail', threadId: '18c5f42779f726f0' };
    expect(parseRoute('/mail/18c5f42779f726f0')).toEqual(thread);
    expect(buildPath(thread)).toBe('/mail/18c5f42779f726f0');
    expect(roundTrip(thread)).toEqual(thread);
  });

  it('round-trips slack and a slack channel', () => {
    const workspace: Route = { kind: 'home', view: 'slack' };
    expect(parseRoute('/slack')).toEqual(workspace);
    expect(buildPath(workspace)).toBe('/slack');
    const channel: Route = { kind: 'home', view: 'slack', channelId: 'C0123ABCD' };
    expect(parseRoute('/slack/C0123ABCD')).toEqual(channel);
    expect(buildPath(channel)).toBe('/slack/C0123ABCD');
    expect(roundTrip(channel)).toEqual(channel);
  });

  it('round-trips dev and a github repo', () => {
    const hub: Route = { kind: 'home', view: 'dev' };
    expect(parseRoute('/dev')).toEqual(hub);
    expect(buildPath(hub)).toBe('/dev');
    const repo: Route = { kind: 'home', view: 'dev', owner: 'nexu-io', repo: 'open-design' };
    expect(parseRoute('/dev/nexu-io/open-design')).toEqual(repo);
    expect(buildPath(repo)).toBe('/dev/nexu-io/open-design');
    expect(roundTrip(repo)).toEqual(repo);
  });

  it('round-trips team chat and a team channel', () => {
    const workspace: Route = { kind: 'home', view: 'team' };
    expect(parseRoute('/team')).toEqual(workspace);
    expect(buildPath(workspace)).toBe('/team');
    const channel: Route = { kind: 'home', view: 'team', channelId: 'general' };
    expect(parseRoute('/team/general')).toEqual(channel);
    expect(buildPath(channel)).toBe('/team/general');
    expect(roundTrip(channel)).toEqual(channel);
  });

  it('round-trips organization search', () => {
    const route: Route = { kind: 'home', view: 'search' };
    expect(parseRoute('/search')).toEqual(route);
    expect(buildPath(route)).toBe('/search');
    expect(roundTrip(route)).toEqual(route);
  });

  it('falls back to home when the URL is unrecognized', () => {
    expect(parseRoute('/something/else')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/projects')).toEqual({ kind: 'home', view: 'projects' });
  });
});
