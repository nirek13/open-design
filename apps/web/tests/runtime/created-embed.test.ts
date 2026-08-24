import { describe, expect, it } from 'vitest';
import type { OrgApp, Project, ProjectFile } from '@open-design/contracts';
import {
  classifyCreatedFile,
  createdFileUrl,
  loadCreatedEmbedItems,
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
    expect(classifyCreatedFile(file({ name: 'notes.md', kind: 'text' }))).toBeNull();
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
