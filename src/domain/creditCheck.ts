/**
 * The credit check — pure, so every refusal reason is a unit test.
 *
 * Day 18 (the counter) checks the two things a cashier must never override: a dealer on hold, and
 * a sale that would take the dealer over their limit. Day 31 widens *exposure* to include open
 * orders and unallocated receipts, and adds the override-with-reason flow for managers.
 */

export interface CreditPosition {
  creditHold: boolean;
  creditHoldReason: string | null;
  creditLimitMinor: number;
  /** What they owe now — `Party.currentBalanceMinor`. */
  currentBalanceMinor: number;
}

export type CreditVerdict =
  | { ok: true; exposureAfterMinor: number }
  | {
      ok: false;
      reason: 'ON_HOLD' | 'OVER_LIMIT' | 'CASH_ONLY';
      message: string;
      exposureAfterMinor: number;
      limitMinor: number;
    };

/**
 * Whether `newCreditMinor` more of credit may be extended.
 *
 * `enforceLimit` is `org.settings.enforceCreditLimit`. A hold is refused regardless — it is a
 * person's explicit decision, not a threshold. A limit of zero means cash only.
 */
export function checkCredit(
  p: CreditPosition,
  newCreditMinor: number,
  enforceLimit: boolean,
): CreditVerdict {
  const exposureAfterMinor = p.currentBalanceMinor + newCreditMinor;
  if (newCreditMinor <= 0) return { ok: true, exposureAfterMinor };

  if (p.creditHold) {
    return {
      ok: false,
      reason: 'ON_HOLD',
      message: `On credit hold${p.creditHoldReason ? `: ${p.creditHoldReason}` : ''}`,
      exposureAfterMinor,
      limitMinor: p.creditLimitMinor,
    };
  }
  if (!enforceLimit) return { ok: true, exposureAfterMinor };
  if (p.creditLimitMinor <= 0) {
    return {
      ok: false,
      reason: 'CASH_ONLY',
      message: 'This dealer has no credit limit — cash only',
      exposureAfterMinor,
      limitMinor: 0,
    };
  }
  if (exposureAfterMinor > p.creditLimitMinor) {
    return {
      ok: false,
      reason: 'OVER_LIMIT',
      message: 'This sale would take the dealer over their credit limit',
      exposureAfterMinor,
      limitMinor: p.creditLimitMinor,
    };
  }
  return { ok: true, exposureAfterMinor };
}
