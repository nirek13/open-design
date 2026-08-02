import { describe, expect, it } from 'vitest';
import { normalizeSlug, suggestSlug, validateSlug } from '../src/slug.ts';

describe('normalizeSlug', () => {
  it('lowercases and hyphenates arbitrary text', () => {
    expect(normalizeSlug('My Expense Form')).toBe('my-expense-form');
  });

  it('strips accents rather than dropping the letter', () => {
    expect(normalizeSlug('Café Menu')).toBe('cafe-menu');
  });

  it('collapses runs of separators and trims the edges', () => {
    expect(normalizeSlug('  ---Hello___World!!!  ')).toBe('hello-world');
  });

  it('never leaves a trailing hyphen after truncation', () => {
    const long = `${'a'.repeat(62)} tail`;
    const result = normalizeSlug(long);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith('-')).toBe(false);
  });

  it('returns empty for text with nothing slug-able in it', () => {
    expect(normalizeSlug('!!!')).toBe('');
  });
});

describe('validateSlug', () => {
  it('accepts a well-formed slug', () => {
    expect(validateSlug('my-app-42')).toEqual({ ok: true, slug: 'my-app-42' });
  });

  it.each([
    ['', 'empty'],
    ['ab', 'too-short'],
    ['a'.repeat(64), 'too-long'],
    ['My-App', 'invalid-characters'],
    ['under_score', 'invalid-characters'],
    ['-leading', 'leading-or-trailing-hyphen'],
    ['trailing-', 'leading-or-trailing-hyphen'],
    ['double--hyphen', 'consecutive-hyphens'],
    ['12345', 'all-numeric'],
    ['admin', 'reserved'],
    ['login', 'reserved'],
  ])('rejects %j as %s', (input, reason) => {
    const result = validateSlug(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('rejects the punycode prefix before the generic hyphen rule', () => {
    // `xn--` would let a slug render as arbitrary Unicode in the address bar,
    // which is a homograph-spoofing vector — it must not be reported as a
    // mere formatting problem.
    const result = validateSlug('xn--e1afmkfd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('punycode-prefix');
  });

  it('rejects a slug that is exactly a DNS label too long', () => {
    expect(validateSlug('a'.repeat(63)).ok).toBe(true);
    expect(validateSlug('a'.repeat(64)).ok).toBe(false);
  });
});

describe('suggestSlug', () => {
  it('combines a normalized project name with the disambiguator', () => {
    expect(suggestSlug('Expense Form', 'k3f9')).toBe('expense-form-k3f9');
  });

  it('keeps the result inside the DNS label limit', () => {
    const suggestion = suggestSlug('x'.repeat(120), 'ab12');
    expect(suggestion.length).toBeLessThanOrEqual(63);
    expect(validateSlug(suggestion).ok).toBe(true);
  });

  it('produces a valid slug even when the name normalizes to nothing', () => {
    const suggestion = suggestSlug('!!!', 'k3f9');
    expect(validateSlug(suggestion).ok).toBe(true);
  });

  it('escapes a reserved name by suffixing rather than failing', () => {
    // "admin" alone is reserved; "admin-k3f9" is not, and it stays recognizable
    // to the person who named their project that.
    const suggestion = suggestSlug('admin', 'k3f9');
    expect(suggestion).toBe('admin-k3f9');
    expect(validateSlug(suggestion).ok).toBe(true);
  });
});
