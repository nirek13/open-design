import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_STYLE,
  PAGE_BLOCK_CATALOG,
  PAGE_BLOCK_TYPES,
  parsePageStyle,
  parsePageVisibility,
  partitionPageTree,
  type WorkspacePage,
} from '../src/api/pages.js';

describe('page contracts', () => {
  it('covers Notion document blocks plus Substrate bridges', () => {
    expect(PAGE_BLOCK_TYPES).toContain('paragraph');
    expect(PAGE_BLOCK_TYPES).toContain('image');
    expect(PAGE_BLOCK_TYPES).toContain('equation');
    expect(PAGE_BLOCK_TYPES).toContain('table_of_contents');
    expect(PAGE_BLOCK_TYPES).toContain('breadcrumb');
    expect(PAGE_BLOCK_TYPES).toContain('column_list');
    expect(PAGE_BLOCK_TYPES).toContain('column');
    expect(PAGE_BLOCK_TYPES).toContain('video');
    expect(PAGE_BLOCK_TYPES).toContain('audio');
    expect(PAGE_BLOCK_TYPES).toContain('file');
    expect(PAGE_BLOCK_TYPES).toContain('pdf');
    expect(PAGE_BLOCK_TYPES).toContain('database');
    expect(PAGE_BLOCK_TYPES).toContain('board');
    expect(PAGE_BLOCK_TYPES).toContain('checklist');
    expect(PAGE_BLOCK_TYPES).toContain('assigner');
    expect(PAGE_BLOCK_TYPES).toContain('poll');
    expect(PAGE_BLOCK_TYPES).toContain('timeline');
    expect(PAGE_BLOCK_TYPES).toContain('decision');
    expect(PAGE_BLOCK_TYPES).toContain('goals');
    expect(PAGE_BLOCK_TYPES).toContain('spreadsheet');
    expect(PAGE_BLOCK_TYPES).toContain('budget');
    expect(PAGE_BLOCK_TYPES).toContain('calendar');
    expect(PAGE_BLOCK_TYPES).toContain('habit');
    expect(PAGE_BLOCK_TYPES).toContain('countdown');
    expect(PAGE_BLOCK_TYPES).toContain('schedule');
    expect(new Set(PAGE_BLOCK_TYPES).size).toBe(PAGE_BLOCK_TYPES.length);
  });

  it('lists slash items for every user-facing type except column', () => {
    const catalogTypes = new Set(PAGE_BLOCK_CATALOG.map((item) => item.type));
    for (const type of PAGE_BLOCK_TYPES) {
      if (type === 'column') continue;
      expect(catalogTypes.has(type)).toBe(true);
    }
    expect(catalogTypes.has('column')).toBe(false);
  });

  it('parses page appearance with a safe default', () => {
    expect(parsePageStyle(null)).toEqual({});
    expect(parsePageStyle({ font: 'serif', smallText: true, fullWidth: true, locked: true })).toEqual({
      font: 'serif',
      smallText: true,
      fullWidth: true,
      locked: true,
    });
    expect(parsePageStyle({ font: 'comic', smallText: 'yes' })).toEqual({});
    expect(DEFAULT_PAGE_STYLE.font).toBe('default');
  });

  it('treats unknown visibility as public', () => {
    expect(parsePageVisibility(undefined)).toBe('public');
    expect(parsePageVisibility('public')).toBe('public');
    expect(parsePageVisibility('private')).toBe('private');
    expect(parsePageVisibility('link')).toBe('public');
  });

  it('splits a mixed tree into public and private sections', () => {
    const publicRoot: WorkspacePage = {
      id: 'pub',
      orgId: 'org',
      parentPageId: null,
      title: 'Handbook',
      icon: null,
      cover: null,
      linkedRecordId: null,
      linkedTableId: null,
      style: {},
      visibility: 'public',
      position: 0,
      createdBy: 'm1',
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    };
    const privateChild: WorkspacePage = {
      ...publicRoot,
      id: 'priv',
      parentPageId: 'pub',
      title: 'Draft',
      visibility: 'private',
      position: 1,
    };
    const { publicPages, privatePages } = partitionPageTree([
      { page: publicRoot, children: [{ page: privateChild, children: [] }] },
    ]);
    expect(publicPages).toHaveLength(1);
    expect(publicPages[0]!.page.id).toBe('pub');
    expect(publicPages[0]!.children).toHaveLength(0);
    expect(privatePages).toHaveLength(1);
    expect(privatePages[0]!.page.id).toBe('priv');
    expect(privatePages[0]!.page.parentPageId).toBe('pub');
  });
});
