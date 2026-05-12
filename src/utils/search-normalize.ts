/**
 * Normalize a string for fuzzy keyword matching.
 *
 * Collapses any run of `-`, `_`, or whitespace into a single space and
 * lowercases. This lets the user search "function calling" and match a
 * feature named "function-calling" — matching only by `includes()` would
 * miss it because of the punctuation difference.
 */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_\s]+/g, ' ')
    .trim();
}
