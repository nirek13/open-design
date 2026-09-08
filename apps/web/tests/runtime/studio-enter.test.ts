// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { prefersReducedMotion, withStudioEnterTransition } from '../../src/runtime/studio-enter';

vi.mock('react-dom', () => ({
  flushSync: vi.fn((fn?: () => void) => {
    fn?.();
  }),
}));

afterEach(() => {
  document.documentElement.classList.remove('od-studio-enter');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('studio enter transition', () => {
  it('skips the wrap when the user prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const update = vi.fn();
    const startViewTransition = vi.fn();
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });

    expect(prefersReducedMotion()).toBe(true);
    await withStudioEnterTransition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('od-studio-enter')).toBe(false);
  });

  it('runs the update immediately when view transitions are unavailable', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: undefined,
    });
    const update = vi.fn();
    await withStudioEnterTransition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('od-studio-enter')).toBe(false);
  });

  it('keeps the enter class until the transition finishes', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const startViewTransition = vi.fn((update: () => void | Promise<void>) => {
      expect(document.documentElement.classList.contains('od-studio-enter')).toBe(true);
      void Promise.resolve(update());
      return { finished };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });
    const update = vi.fn();

    const pending = withStudioEnterTransition(update);
    expect(startViewTransition).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(flushSync).toHaveBeenCalled());
    expect(document.documentElement.classList.contains('od-studio-enter')).toBe(true);
    finish();
    await pending;
    expect(document.documentElement.classList.contains('od-studio-enter')).toBe(false);
  });
});
