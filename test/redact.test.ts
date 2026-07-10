import { describe, it, expect } from 'vitest';
import { luhnValid, redactSecrets, CC_REDACTION, SSN_REDACTION } from '@/common/redact';

describe('luhnValid', () => {
  it('accepts Luhn-valid card numbers and rejects the off-by-one sibling', () => {
    expect(luhnValid('4111111111111111')).toBe(true); // classic Visa test card
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('5555555555554444')).toBe(true); // Mastercard test card
  });
});

describe('redactSecrets', () => {
  it('masks Luhn-valid cards whether spaced, hyphenated, or bare', () => {
    expect(redactSecrets('pay 4111 1111 1111 1111 now')).toBe(`pay ${CC_REDACTION} now`);
    expect(redactSecrets('card 4111-1111-1111-1111.')).toBe(`card ${CC_REDACTION}.`);
    expect(redactSecrets('4111111111111111')).toBe(CC_REDACTION);
  });

  it('leaves long numbers that fail the Luhn check untouched', () => {
    expect(redactSecrets('order 4111 1111 1111 1112')).toBe('order 4111 1111 1111 1112');
    expect(redactSecrets('id 1234567890123')).toBe('id 1234567890123');
  });

  it('masks dashed/spaced SSNs but not similarly shaped non-SSNs', () => {
    expect(redactSecrets('SSN 123-45-6789 on file')).toBe(`SSN ${SSN_REDACTION} on file`);
    expect(redactSecrets('call 123-456-7890')).toBe('call 123-456-7890'); // phone shape, not SSN
    expect(redactSecrets('code 000-12-3456')).toBe('code 000-12-3456'); // invalid area, kept
  });

  it('returns the input unchanged when nothing matches', () => {
    const html = '<article><h1>Cats</h1><p>Just ordinary prose.</p></article>';
    expect(redactSecrets(html)).toBe(html);
  });
});
