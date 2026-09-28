/**
 * Stock reconciliation — pure comparison, so the rule is a unit test.
 *
 * The ledger is the truth; balances are caches kept in step by `stock.service` in the same
 * transaction as every movement. Reconciling re-derives each cache from the truth and lists every
 * place they disagree. With the single-writer design there should never be any — a drift is a
 * bug (or a hand edit to the database), and the report is how it gets noticed.
 *
 * It **reports** and never repairs. An automatic "fix" would overwrite the evidence of whatever
 * caused the drift, and the next one would be just as invisible.
 */

export interface DriftRow {
  /** Stable key of what was compared — location|product|variant, or location|lot. */
  key: string;
  /** What the truth says. */
  expected: number;
  /** What the cache holds. */
  actual: number;
  /** actual − expected: positive means the cache shows more than the ledger explains. */
  drift: number;
}

/**
 * Compare truth against cache by key. A key present on only one side counts as zero on the other
 * — a balance row with no ledger behind it is drift, and so is ledger stock with no balance row.
 * Rows where both sides are zero are not drift.
 */
export function compareCounts(
  truth: ReadonlyMap<string, number>,
  cache: ReadonlyMap<string, number>,
): DriftRow[] {
  const keys = new Set([...truth.keys(), ...cache.keys()]);
  const rows: DriftRow[] = [];
  for (const key of keys) {
    const expected = truth.get(key) ?? 0;
    const actual = cache.get(key) ?? 0;
    if (expected !== actual) rows.push({ key, expected, actual, drift: actual - expected });
  }
  return rows.sort(
    (a, b) => Math.abs(b.drift) - Math.abs(a.drift) || a.key.localeCompare(b.key),
  );
}
