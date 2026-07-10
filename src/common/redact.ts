// Best-effort redaction of obvious secrets from captured HTML before it leaves
// the browser. This is a defence-in-depth complement to the domain/path/page
// exclusions — even on an allowed page, the DOM can contain a card number or
// SSN (e.g. an order-confirmation or profile page). We mask high-confidence
// patterns only, to keep false positives (redacting ordinary long numbers)
// low: card candidates must pass a Luhn check, and SSNs must match the dashed
// shape. Redaction is intentionally conservative; the server never needs these
// tokens to index a page.

export const CC_REDACTION = '[REDACTED-CC]';
export const SSN_REDACTION = '[REDACTED-SSN]';

// 13–19 digits, optionally grouped by single spaces or hyphens (never both an
// opening/closing separator). Bounded by non-digit/word edges.
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
// US SSN: 3-2-4 grouped by hyphens (or spaces). Excludes the all-zero groups
// the SSA never issues, which also filters some incidental matches.
const SSN_PATTERN = /\b(?!000|666|9\d\d)\d{3}[ -](?!00)\d{2}[ -](?!0000)\d{4}\b/g;

/** Luhn checksum — the mod-10 check every real payment card satisfies. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' === 48
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Replace Luhn-valid card numbers and dashed SSNs with fixed placeholders.
 * Returns the input unchanged when nothing matches.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? CC_REDACTION : match;
    })
    .replace(SSN_PATTERN, SSN_REDACTION);
}
