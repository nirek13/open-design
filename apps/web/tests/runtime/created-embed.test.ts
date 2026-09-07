import { describe, expect, it } from 'vitest';
import type { OrgApp, Project, ProjectFile } from '@open-design/contracts';
import {
  classifyCreatedFile,
  collectPageEmbedUrls,
  createdFileUrl,
  loadCreatedEmbedItems,
  mergeMissingMediaBlocks,
  selectProjectFilesToEmbed,
} from '../../src/runtime/created-embed';

function file(partial: Partial<ProjectFile> & Pick<ProjectFile, 'name'>): ProjectFile {
  return {
    size: 1,
    mtime: 1,
    kind: 'binary',
    mime: 'application/octet-stream',
    ...partial,
  } as ProjectFile;
}

describe('classifyCreatedFile', () => {
  it('classifies pictures, videos, apps, and slides', () => {
    expect(classifyCreatedFile(file({ name: 'hero.png', kind: 'image' }))).toBe('image');
    expect(classifyCreatedFile(file({ name: 'clip.mp4', kind: 'video' }))).toBe('video');
    expect(classifyCreatedFile(file({ name: 'crm.html', kind: 'html' }))).toBe('app');
    expect(classifyCreatedFile(file({ name: 'pitch-deck.html', kind: 'html' }))).toBe('slides');
    expect(classifyCreatedFile(file({ name: 'q3.html', kind: 'html', artifactKind: 'deck' }))).toBe(
      'slides',
    );
    expect(classifyCreatedFile(file({ name: 'revenue-chart.html', kind: 'html' }))).toBe('app');
    expect(classifyCreatedFile(file({ name: 'funnel.svg', kind: 'sketch' }))).toBe('image');
  });
});

describe('selectProjectFilesToEmbed', () => {
  it('picks a chart html file that is not yet on the notes page', () => {
    const projectId = 'proj-chart';
    const chart = file({
      name: 'revenue-chart.html',
      path: 'revenue-chart.html',
      kind: 'html',
      mime: 'text/html',
      size: 2048,
    });
    const pending = selectProjectFilesToEmbed({
      files: [chart, file({ name: 'notes.md', kind: 'text', size: 12 })],
      projectId,
      alreadySeen: new Set(),
      pageUrls: collectPageEmbedUrls([{ type: 'paragraph', text: 'Welcome', props: {} }]),
    });
    expect(pending).toEqual([
      {
        url: createdFileUrl(projectId, 'revenue-chart.html'),
        key: createdFileUrl(projectId, 'revenue-chart.html'),
        rel: 'revenue-chart.html',
      },
    ]);
  });

  it('picks a nested chart html file that is not yet on the notes page', () => {
    const projectId = 'proj-chart';
    const pending = selectProjectFilesToEmbed({
      files: [
        file({
          name: 'charts/revenue.html',
          path: 'charts/revenue.html',
          kind: 'html',
          mime: 'text/html',
          size: 2048,
        }),
      ],
      projectId,
      alreadySeen: new Set(),
      pageUrls: new Set(),
    });
    expect(pending[0]?.url).toBe(createdFileUrl(projectId, 'charts/revenue.html'));
  });

  it('does not treat a paragraph that mentions the file as already embedded', () => {
    const url = createdFileUrl('proj-chart', 'revenue-chart.html');
    const pending = selectProjectFilesToEmbed({
      files: [
        file({
          name: 'revenue-chart.html',
          path: 'revenue-chart.html',
          kind: 'html',
          mime: 'text/html',
          size: 2048,
        }),
      ],
      projectId: 'proj-chart',
      alreadySeen: new Set(),
      pageUrls: collectPageEmbedUrls([{ type: 'paragraph', text: `See ${url}`, props: {} }]),
    });
    expect(pending).toHaveLength(1);
  });

  it('skips files already embedded on the page', () => {
    const projectId = 'proj-chart';
    const url = createdFileUrl(projectId, 'revenue-chart.html');
    const pending = selectProjectFilesToEmbed({
      files: [
        file({
          name: 'revenue-chart.html',
          path: 'revenue-chart.html',
          kind: 'html',
          mime: 'text/html',
          size: 2048,
        }),
      ],
      projectId,
      alreadySeen: new Set(),
      pageUrls: collectPageEmbedUrls([{ type: 'embed', text: url, props: { url } }]),
    });
    expect(pending).toEqual([]);
  });
});

describe('mergeMissingMediaBlocks', () => {
  it('appends a live chart embed that a stale draft snapshot omitted', () => {
    const chartUrl = createdFileUrl('proj-chart', 'revenue-chart.html');
    const merged = mergeMissingMediaBlocks(
      [{ type: 'paragraph', text: 'Welcome', props: {} }],
      [{ type: 'embed', text: chartUrl, props: { url: chartUrl } }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ type: 'embed', props: { url: chartUrl } });
  });
});

describe('loadCreatedEmbedItems', () => {
  it('lists published apps and created media so a page can embed them', async () => {
    const items = await loadCreatedEmbedItems('org-1', {
      listApps: async () =>
        [
          {
            id: 'app-1',
            name: 'Expense form',
            projectId: 'p1',
            filePath: 'expense-form.html',
            status: 'active',
          },
        ] as OrgApp[],
      listProjects: async () =>
        [{ id: 'p1', name: 'Campaign', updatedAt: 20 }] as Project[],
      listFiles: async () => [
        file({ name: 'hero.png', kind: 'image' }),
        file({ name: 'walkthrough.mp4', kind: 'video' }),
        file({ name: 'pitch-deck.html', kind: 'html' }),
        file({ name: 'expense-form.html', kind: 'html' }),
      ],
    });

    expect(items.find((item) => item.kind === 'app' && item.title === 'Expense form')?.url).toBe(
      createdFileUrl('p1', 'expense-form.html'),
    );
    expect(items.some((item) => item.kind === 'image' && item.title === 'Hero')).toBe(true);
    expect(items.some((item) => item.kind === 'video' && item.title === 'Walkthrough')).toBe(true);
    expect(items.some((item) => item.kind === 'slides' && item.title === 'Pitch Deck')).toBe(true);
    expect(items.filter((item) => item.url === createdFileUrl('p1', 'expense-form.html'))).toHaveLength(
      1,
    );
  });
});
