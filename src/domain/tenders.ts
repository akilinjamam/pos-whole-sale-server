/**
 * Splitting a counter payment across tenders — pure, so the change arithmetic is a unit test.
 *
 * Only cash gives change. Card, mobile money and bank tenders are applied exactly; cash covers
 * whatever they leave, and anything above that is change handed back — never recorded as money
 * received, so the drawer's expected cash is what actually stayed in it.
 */

export class TenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenderError';
  }
}

export interface TenderLike {
  method: string;
  amountMinor: number;
}

/** Split the tenders into what each actually pays, and the change owed. Pure. */
export function applyTenders(
  tenders: readonly TenderLike[],
  totalMinor: number,
): { applied: number[]; paidMinor: number; changeMinor: number } {
  // Non-cash tenders are exact: nobody gives change on a card or a bKash transfer.
  const nonCash = tenders
    .filter((t) => t.method !== 'CASH')
    .reduce((s, t) => s + t.amountMinor, 0);
  if (nonCash > totalMinor) {
    throw new TenderError(
      'Card, mobile and bank payments cannot exceed the total — only cash gives change',
    );
  }
  let cashRoom = totalMinor - nonCash;
  const applied = tenders.map((t) => {
    if (t.method !== 'CASH') return t.amountMinor;
    const used = Math.min(t.amountMinor, cashRoom);
    cashRoom -= used;
    return used;
  });
  const cashTendered = tenders
    .filter((t) => t.method === 'CASH')
    .reduce((s, t) => s + t.amountMinor, 0);
  const cashUsed = applied.reduce((s, a, i) => s + (tenders[i]!.method === 'CASH' ? a : 0), 0);
  return { applied, paidMinor: nonCash + cashUsed, changeMinor: cashTendered - cashUsed };
}
