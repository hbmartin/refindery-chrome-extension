import { describe, it, expect } from 'vitest';
import { canonicalKey, domainOf, hostOf } from '@/common/canonical';

describe('canonicalKey', () => {
  it('strips utm_* and known tracking params', () => {
    const a = canonicalKey('https://example.com/article?utm_source=x&utm_medium=y&id=5');
    const b = canonicalKey('https://example.com/article?id=5');
    expect(a).toBe(b);
  });

  it('strips fbclid, gclid, ref, si', () => {
    expect(canonicalKey('https://ex.com/p?fbclid=1&gclid=2&ref=z&si=q')).toBe('https://ex.com/p');
  });

  it('keeps meaningful query params and sorts them', () => {
    expect(canonicalKey('https://ex.com/s?b=2&a=1')).toBe('https://ex.com/s?a=1&b=2');
  });

  it('drops the fragment and lowercases the host', () => {
    expect(canonicalKey('https://Example.COM/p#section')).toBe('https://example.com/p');
  });

  it('normalizes trailing slashes except root', () => {
    expect(canonicalKey('https://ex.com/a/b/')).toBe('https://ex.com/a/b');
    expect(canonicalKey('https://ex.com/')).toBe('https://ex.com/');
  });

  it('treats utm-only variants as the same page', () => {
    expect(canonicalKey('https://ex.com/x?utm_source=a')).toBe(canonicalKey('https://ex.com/x'));
  });

  it('returns null for unparseable input', () => {
    expect(canonicalKey('not a url')).toBeNull();
  });
});

describe('domainOf / hostOf', () => {
  it('domainOf strips www', () => {
    expect(domainOf('https://www.example.com/x')).toBe('example.com');
  });
  it('hostOf keeps subdomains', () => {
    expect(hostOf('https://sub.example.com/x')).toBe('sub.example.com');
  });
});
