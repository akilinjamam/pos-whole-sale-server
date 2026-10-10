/**
 * A received cheque's life — §8, Day 30. Pure, so every edge is a unit test.
 *
 *   PENDING ──deposit──► DEPOSITED ──clear──► CLEARED ──bounce──► BOUNCED
 *      │                     │
 *      ├──clear (paid in over the counter, or a same-bank cheque) ──► CLEARED
 *      └──bounce ────────────┴──► BOUNCED   (returned before it ever cleared)
 *
 * A cheque's money is not the business's until it clears, so nothing posts before CLEARED: no
 * ledger credit, no invoice paid, no advance. Clearing posts both. A bounce after clearing reverses
 * them; a bounce before clearing has nothing to reverse.
 */

import type { ChequeStatus } from '@shared/enums.js';

export const CHEQUE_TRANSITIONS: Readonly<Record<ChequeStatus, readonly ChequeStatus[]>> = {
  PENDING: ['DEPOSITED', 'CLEARED', 'BOUNCED'],
  DEPOSITED: ['CLEARED', 'BOUNCED'],
  CLEARED: ['BOUNCED'],
  BOUNCED: [],
};

export function canMoveCheque(from: ChequeStatus, to: ChequeStatus): boolean {
  return CHEQUE_TRANSITIONS[from].includes(to);
}

/** Whether moving `from` → BOUNCED has postings to reverse: only a cleared cheque posted any. */
export const bounceReverses = (from: ChequeStatus) => from === 'CLEARED';

export interface Intended {
  invoiceId: string;
  amountMinor: number;
}

/**
 * The allocation to apply when a cheque clears. It was chosen when the cheque was taken — maybe
 * weeks ago, for a post-dated cheque — and the invoices may have been paid by something else since.
 * Each line is capped at what its invoice still owes now (an invoice no longer open gets nothing);
 * whatever is not applied stays on the receipt as an advance.
 *
 * Clearing is driven by the bank statement: refusing it because the intended split went stale would
 * leave money in the bank and not in the books. So it never refuses — it applies what still fits.
 */
export function capToOpen(
  intended: readonly Intended[],
  openBalance: ReadonlyMap<string, number>,
): Intended[] {
  const left = new Map(openBalance);
  const out: Intended[] = [];
  for (const a of intended) {
    const room = left.get(a.invoiceId) ?? 0;
    const take = Math.min(a.amountMinor, room);
    if (take > 0) {
      out.push({ invoiceId: a.invoiceId, amountMinor: take });
      left.set(a.invoiceId, room - take);
    }
  }
  return out;
}
