// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  capturePendingInvite,
  clearPendingInvite,
  joinPathForToken,
  joinTokenFromPath,
  readPendingInvite,
  rememberPendingInvite,
} from '../../src/auth/pending-invite';

afterEach(() => {
  clearPendingInvite();
});

describe('pending invite', () => {
  it('reads a join token out of the path, including encoded values', () => {
    expect(joinTokenFromPath('/join/tok-abc')).toBe('tok-abc');
    expect(joinTokenFromPath('/join/tok-abc/')).toBe('tok-abc');
    expect(joinTokenFromPath('/join/a%2Bb')).toBe('a+b');
    expect(joinTokenFromPath('/workspace')).toBeNull();
    expect(joinPathForToken('tok-abc')).toBe('/join/tok-abc');
  });

  it('remembers a join landing so sign-in can return to it', () => {
    expect(capturePendingInvite('/join/tok-abc')).toBe('tok-abc');
    expect(readPendingInvite()).toBe('tok-abc');
    expect(capturePendingInvite('/')).toBe('tok-abc');
    rememberPendingInvite('tok-other');
    expect(readPendingInvite()).toBe('tok-other');
    clearPendingInvite();
    expect(readPendingInvite()).toBeNull();
  });
});
