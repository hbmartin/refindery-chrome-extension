import { describe, it, expect } from 'vitest';
import {
  decideSkip,
  hasSensitivePath,
  isLocalHost,
  hostMatchesDomain,
  urlMatchesGlob,
} from '@/common/exclusions';
import { DEFAULT_SETTINGS, type Settings } from '@/common/settings';

const base: Settings = { ...DEFAULT_SETTINGS };
const ctx = (over: Partial<Settings> = {}) => ({
  incognito: false,
  paused: false,
  settings: { ...base, ...over },
});

describe('isLocalHost', () => {
  it('flags loopback and private ranges', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.2',
      '172.16.4.4',
      '169.254.1.1',
      'foo.local',
    ]) {
      expect(isLocalHost(h)).toBe(true);
    }
  });
  it('does not flag public hosts', () => {
    for (const h of ['example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
      expect(isLocalHost(h)).toBe(false);
    }
  });
});

describe('hostMatchesDomain', () => {
  it('matches exact and subdomains', () => {
    expect(hostMatchesDomain('a.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('notexample.com', 'example.com')).toBe(false);
  });
});

describe('urlMatchesGlob', () => {
  it('supports * wildcards', () => {
    expect(urlMatchesGlob('https://ex.com/private/x', 'https://ex.com/private/*')).toBe(true);
    expect(urlMatchesGlob('https://ex.com/public/x', 'https://ex.com/private/*')).toBe(false);
  });
});

describe('decideSkip', () => {
  it('skips when paused', () => {
    expect(decideSkip('https://example.com', ctx()).skip).toBe(false);
    expect(decideSkip('https://example.com', { ...ctx(), paused: true }).skip).toBe(true);
  });
  it('skips incognito', () => {
    expect(decideSkip('https://example.com', { ...ctx(), incognito: true }).reason).toBe(
      'incognito',
    );
  });
  it('skips non-web schemes and local hosts', () => {
    expect(decideSkip('chrome://settings', ctx()).reason).toBe('non-web-scheme');
    expect(decideSkip('https://127.0.0.1:3000/app', ctx()).reason).toBe('local-host');
  });
  it('skips default sensitive-category domains', () => {
    const d = decideSkip('https://mail.google.com/mail/u/0', ctx());
    expect(d.skip).toBe(true);
    expect(d.reason).toContain('sensitive:webmail');
  });
  it('allows a sensitive category when the user disables it', () => {
    const d = decideSkip('https://chase.com/home', ctx({ disabledDefaultCategories: ['banking'] }));
    expect(d.skip).toBe(false);
  });
  it('applies user skip rules', () => {
    const d = decideSkip(
      'https://blocked.com/x',
      ctx({ userSkipRules: [{ pattern: 'blocked.com', kind: 'domain' }] }),
    );
    expect(d.reason).toBe('user-rule:blocked.com');
  });
  it('skips auth/payment URL paths on otherwise-allowed domains', () => {
    for (const url of [
      'https://news.example.com/login',
      'https://shop.example.com/checkout/step-2',
      'https://example.com/account/settings',
      'https://example.com/oauth2/authorize?client_id=x',
    ]) {
      const d = decideSkip(url, ctx());
      expect(d.skip).toBe(true);
      expect(d.reason).toBe('sensitive-path');
    }
  });
  it('allows ordinary public pages', () => {
    expect(decideSkip('https://en.wikipedia.org/wiki/Cats', ctx()).skip).toBe(false);
  });
});

describe('hasSensitivePath', () => {
  it('matches whole path segments, not substrings', () => {
    expect(hasSensitivePath('https://example.com/login')).toBe(true);
    expect(hasSensitivePath('https://example.com/my-account/profile')).toBe(true);
    // "accounts-of-the-siege" is one segment; it must not trip the "accounts" rule.
    expect(hasSensitivePath('https://example.com/accounts-of-the-siege')).toBe(false);
    expect(hasSensitivePath('https://example.com/articles/how-to-log-in-safely')).toBe(false);
  });
  it('returns false for unparseable urls', () => {
    expect(hasSensitivePath('not a url')).toBe(false);
  });
});
