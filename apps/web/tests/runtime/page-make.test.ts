import { describe, expect, it } from 'vitest';
import {
  composePageMakeRequest,
  isPageMakeKind,
  PAGE_MAKE_ACTIONS,
  pageMakeAction,
} from '../../src/runtime/page-make';

describe('page-make', () => {
  it('covers app, picture, video, and slides', () => {
    expect(PAGE_MAKE_ACTIONS.map((item) => item.kind)).toEqual(['app', 'image', 'video', 'slides']);
    expect(pageMakeAction('app').projectKind).toBe('prototype');
    expect(pageMakeAction('image').projectKind).toBe('image');
    expect(pageMakeAction('video').projectKind).toBe('video');
    expect(pageMakeAction('slides').projectKind).toBe('deck');
    expect(isPageMakeKind('app')).toBe(true);
    expect(isPageMakeKind('embed')).toBe(false);
  });

  it('asks the agent to use a native page tool before generating an HTML app', () => {
    const request = composePageMakeRequest('app', 'A hiring dashboard');
    expect(request).toContain('native wiki tool');
    expect(request).toContain('Do not generate HTML and embed it when a native tool covers the request');
    expect(request).toContain('A hiring dashboard');
    expect(request).toContain('unique interactive app');
    expect(request).toContain('tools pages embed');
    expect(request).toContain('--type embed');
    expect(request).toContain('/raw/');
    expect(request).toContain('$OD_PROJECT_ID');
    expect(request).toContain('notes tab bar');
  });

  it('still asks the agent to create a unique file when making a picture', () => {
    const request = composePageMakeRequest('image', 'A hero photo');
    expect(request).toContain('unique picture');
    expect(request).toContain('Do not stop at a description');
    expect(request).toContain('tools pages embed');
    expect(request).toContain('notes tab bar');
  });

  it('fills concrete page and project ids when they are known', () => {
    const request = composePageMakeRequest('image', 'A hero photo', {
      pageId: 'page-1',
      projectId: 'proj-wiki',
    });
    expect(request).toContain('--page page-1');
    expect(request).toContain('/api/projects/proj-wiki/raw/');
    expect(request).not.toContain('<current page id>');
  });
});
