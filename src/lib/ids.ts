import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, sortable-enough, collision-safe id. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = Array.from(randomBytes(8))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');
  return `${prefix}${time}${rand}`;
}

/** Deterministic slug used to build stable natural keys for idempotent import. */
export function slug(...parts: (string | number | null | undefined)[]): string {
  return parts
    .map((p) => (p == null ? '' : String(p)))
    .join('|')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function codeify(value: string, max = 48): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, max);
}
