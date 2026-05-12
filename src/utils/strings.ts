/**
 * Standard Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Return the closest candidate within an edit-distance threshold scaled to
 * the input length, or null if nothing is close enough.
 *
 * Threshold: max(2, floor(input.length * 0.5))
 * — short inputs always allow up to 2 edits, longer inputs allow proportional drift.
 */
export function didYouMean(input: string, candidates: string[]): string | null {
  if (!input || candidates.length === 0) return null;

  const q = input.toLowerCase();
  const best = candidates
    .map((c) => ({ c, d: levenshtein(q, c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)[0];

  const threshold = Math.max(2, Math.floor(input.length * 0.5));
  return best.d <= threshold ? best.c : null;
}
