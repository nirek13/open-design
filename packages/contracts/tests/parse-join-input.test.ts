import { describe, expect, it } from 'vitest';

import { parseJoinInput } from '../src/api/organizations';

describe('parseJoinInput', () => {
  it('pulls the token out of a full invite URL', () => {
    expect(parseJoinInput('https://app.example.com/join/tok-abc?x=1')).toBe('tok-abc');
  });

  it('accepts a /join/<token> path', () => {
    expect(parseJoinInput('/join/tok-abc/')).toBe('tok-abc');
  });

  it('accepts a bare token or code', () => {
    expect(parseJoinInput('  tok-abc  ')).toBe('tok-abc');
  });

  it('returns empty for blank input', () => {
    expect(parseJoinInput('   ')).toBe('');
  });
});
