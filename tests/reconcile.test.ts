import { describe, expect, it } from 'vitest';

import { compareCounts } from '../src/domain/reconcile.js';

/** Reconcile's comparison: the ledger is the truth, the balance a cache that must agree with it. */
describe('compareCounts', () => {
  const m = (entries: [string, number][]) => new Map(entries);

  it('reports nothing when cache and truth agree', () => {
    expect(
      compareCounts(
        m([
          ['a', 5],
          ['b', 0],
        ]),
        m([
          ['a', 5],
          ['b', 0],
        ]),
      ),
    ).toEqual([]);
  });

  it('reports the difference as actual − expected', () => {
    expect(compareCounts(m([['a', 10]]), m([['a', 7]]))).toEqual([
      { key: 'a', expected: 10, actual: 7, drift: -3 },
    ]);
  });

  it('treats a balance with no ledger behind it as drift', () => {
    expect(compareCounts(m([]), m([['ghost', 4]]))).toEqual([
      { key: 'ghost', expected: 0, actual: 4, drift: 4 },
    ]);
  });

  it('treats ledger stock with no balance row as drift', () => {
    expect(compareCounts(m([['lost', 2]]), m([]))).toEqual([
      { key: 'lost', expected: 2, actual: 0, drift: -2 },
    ]);
  });

  it('ignores a zero on one side and nothing on the other', () => {
    expect(compareCounts(m([['a', 0]]), m([]))).toEqual([]);
  });

  it('lists the largest drift first', () => {
    const rows = compareCounts(
      m([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
      m([
        ['a', 2],
        ['b', 11],
        ['c', 0],
      ]),
    );
    expect(rows.map((r) => r.key)).toEqual(['b', 'a', 'c']);
  });
});
