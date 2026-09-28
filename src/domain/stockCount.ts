/**
 * Stock count arithmetic — pure, so the rule "a count posts only the variance" is a unit test.
 *
 * A count never *sets* a balance. It compares what the counters found with what the system held
 * when the count froze the shelf, and posts the difference as a `COUNT` movement. A line that
 * matches posts nothing at all; the ledger records only the surprises, which is what an auditor
 * reading it wants to see.
 */

export interface CountLineLike<Id = string> {
  productId: Id;
  variantId: Id | null;
  expectedBase: number;
  countedBase: number | null;
}

export interface VarianceMovement<Id = string> {
  productId: Id;
  variantId: Id | null;
  /** counted − expected. Never zero. */
  varianceBase: number;
}

export class UncountedLinesError extends Error {
  readonly uncounted: number;

  constructor(uncounted: number) {
    super(`${uncounted} line(s) are not counted yet — count them, or post with skipUncounted`);
    this.name = 'UncountedLinesError';
    this.uncounted = uncounted;
  }
}

export interface VarianceResult<Id> {
  movements: VarianceMovement<Id>[];
  counted: number;
  uncounted: number;
  /** Sum of the variances, base units — negative means stock is missing overall. */
  netVarianceBase: number;
}

/**
 * The movements a count posts.
 *
 * Uncounted lines are refused unless `skipUncounted`: an uncounted line is far more often a
 * missed shelf than a deliberate choice, and treating it as zero would write the whole shelf off.
 * Skipped, an uncounted line posts nothing — the system keeps what it believed.
 */
export function countVariances<Id>(
  lines: readonly CountLineLike<Id>[],
  { skipUncounted = false }: { skipUncounted?: boolean } = {},
): VarianceResult<Id> {
  const uncounted = lines.filter((l) => l.countedBase === null).length;
  if (uncounted > 0 && !skipUncounted) throw new UncountedLinesError(uncounted);

  const movements: VarianceMovement<Id>[] = [];
  for (const line of lines) {
    if (line.countedBase === null) continue;
    const varianceBase = line.countedBase - line.expectedBase;
    if (varianceBase !== 0) {
      movements.push({ productId: line.productId, variantId: line.variantId, varianceBase });
    }
  }

  return {
    movements,
    counted: lines.length - uncounted,
    uncounted,
    netVarianceBase: movements.reduce((sum, m) => sum + m.varianceBase, 0),
  };
}
