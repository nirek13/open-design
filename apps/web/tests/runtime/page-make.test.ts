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

  it('asks the agent to create a unique file and embed it on the page', () => {
    const request = composePageMakeRequest('app', 'A hiring dashboard');
    expect(request).toContain('unique interactive app');
    expect(request).toContain('A hiring dashboard');
    expect(request).toContain('tools pages embed');
    expect(request).toContain('--type embed');
    expect(request).toContain('/raw/');
    expect(request).toContain('Do not stop at a description');
  });
});
