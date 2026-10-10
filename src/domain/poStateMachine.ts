/**
 * The purchase order state machine — §6.8. Pure: no database, no clock.
 *
 * Same shape as the sales side (`orderStateMachine.ts`): one `status`, moved only along the edges
 * in `PO_TRANSITIONS`; `supplierPo.service` calls `canMovePo()` before every status write, and the
 * model refuses any status write that did not come through it.
 *
 *   DRAFT ─approve─► APPROVED ─send─► SENT
 *     ▲                │                │
 *     └────reopen──────┘                │      (an approved PO changed means approved again)
 *                      │ receive        │ receive
 *                      ▼                ▼
 *                 PARTIALLY_RECEIVED ◄──┘ ─receive─► (itself: another GRN)
 *                      │ receive (nothing left)     │ shortClose
 *                      ▼                            ▼
 *                   RECEIVED                    SHORT_CLOSED
 *
 *   DRAFT / APPROVED / SENT ─cancel─► CANCELLED   (only while nothing has been received)
 *   PARTIALLY_RECEIVED ─cancel─► refused by its guard — that is a short close
 *
 * Receiving is not a button: it is what a posted goods receipt (Day 33) does to the PO. The edge
 * is taken by `recordPoReceipt`, which `$inc`s the lines' `qtyReceivedBase` first and then asks
 * the machine where that leaves the PO — part received, or all of it. Goods may arrive against an
 * APPROVED PO that nobody marked as sent: the supplier was phoned, and the boxes are at the door.
 */

import type { PoStatus } from '@shared/enums.js';
import type { Permission } from '@shared/permissions.js';
import type { TransitionRefusal } from './orderStateMachine.js';

export const INITIAL_PO_STATUS = 'DRAFT' satisfies PoStatus;

export const TERMINAL_PO_STATUSES: readonly PoStatus[] = [
  'RECEIVED',
  'SHORT_CLOSED',
  'CANCELLED',
];

/** The PO as the guards see it — *after* the transition's own quantity effects. */
export interface PoTransitionContext {
  permissions: readonly Permission[];
  lineCount: number;
  /** Σ lines.qtyReceivedBase. */
  receivedBase: number;
  /** Σ (qtyBase − qtyReceivedBase − qtyCancelledBase): still to come. */
  outstandingBase: number;
  reason?: string | null;
}

export type PoAction = 'approve' | 'reopen' | 'send' | 'receive' | 'cancel' | 'shortClose';

type Guard = (c: PoTransitionContext) => string | null;

export interface PoTransitionRule {
  action: PoAction;
  from: readonly PoStatus[];
  to: PoStatus;
  permission: Permission;
  guard?: Guard;
  requiresReason?: boolean | ((from: PoStatus) => boolean);
}

const all =
  (...guards: Guard[]): Guard =>
  (c) => {
    for (const g of guards) {
      const why = g(c);
      if (why) return why;
    }
    return null;
  };

const hasLines: Guard = (c) => (c.lineCount > 0 ? null : 'The purchase order has no lines');
const nothingReceived: Guard = (c) =>
  c.receivedBase === 0 ? null : 'Goods have been received against it — short-close it instead';
const somethingReceived: Guard = (c) =>
  c.receivedBase > 0 ? null : 'Nothing has been received yet — cancel it instead';
const stillOutstanding: Guard = (c) =>
  c.outstandingBase > 0 ? null : 'Every line has been received';
const nothingOutstanding: Guard = (c) =>
  c.outstandingBase === 0 ? null : 'Lines remain to be received';

export const PO_TRANSITIONS = [
  {
    action: 'approve',
    from: ['DRAFT'],
    to: 'APPROVED',
    permission: 'po:approve',
    guard: hasLines,
  },
  {
    // Changing an approved PO sends it back for approval — the approval was of what it said then.
    action: 'reopen',
    from: ['APPROVED'],
    to: 'DRAFT',
    permission: 'po:update',
    requiresReason: true,
  },
  {
    action: 'send',
    from: ['APPROVED'],
    to: 'SENT',
    permission: 'po:update',
  },
  {
    // A goods receipt that leaves something still to come. PARTIALLY_RECEIVED → itself is a real
    // edge: each GRN is a line in the PO's timeline.
    action: 'receive',
    from: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'],
    to: 'PARTIALLY_RECEIVED',
    permission: 'grn:create',
    guard: all(somethingReceived, stillOutstanding),
  },
  {
    action: 'receive',
    from: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'],
    to: 'RECEIVED',
    permission: 'grn:create',
    guard: all(somethingReceived, nothingOutstanding),
  },
  {
    // A draft was nobody's commitment; past it, the supplier may already be packing — say why.
    // PARTIALLY_RECEIVED is listed only so its guard can say "short-close it instead": once goods
    // have arrived, a cancel would pretend they had not.
    action: 'cancel',
    from: ['DRAFT', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'],
    to: 'CANCELLED',
    permission: 'po:cancel',
    guard: nothingReceived,
    requiresReason: (from) => from !== 'DRAFT',
  },
  {
    // "They sent 80 of 100 and the rest is not coming": the remainder is cancelled line by line.
    action: 'shortClose',
    from: ['PARTIALLY_RECEIVED'],
    to: 'SHORT_CLOSED',
    permission: 'po:shortClose',
    guard: somethingReceived,
    requiresReason: true,
  },
] as const satisfies readonly PoTransitionRule[];

const BY_EDGE = new Map<string, PoTransitionRule>();
for (const rule of PO_TRANSITIONS as readonly PoTransitionRule[]) {
  for (const from of rule.from) {
    const key = `${from}>${rule.to}`;
    if (BY_EDGE.has(key)) throw new Error(`Duplicate PO transition ${key}`);
    BY_EDGE.set(key, rule);
  }
}

export function poRuleFor(from: PoStatus, to: PoStatus): PoTransitionRule | undefined {
  return BY_EDGE.get(`${from}>${to}`);
}

function reasonRequired(rule: PoTransitionRule, from: PoStatus): boolean {
  return typeof rule.requiresReason === 'function'
    ? rule.requiresReason(from)
    : (rule.requiresReason ?? false);
}

export type PoTransitionVerdict =
  | { ok: true; rule: PoTransitionRule }
  | { ok: false; refusal: TransitionRefusal; message: string; rule?: PoTransitionRule };

/** Whether the PO may move `from` → `to`: edge, permission, reason, guard — in that order. */
export function canMovePo(
  from: PoStatus,
  to: PoStatus,
  ctx: PoTransitionContext,
): PoTransitionVerdict {
  const rule = poRuleFor(from, to);
  if (!rule) {
    return {
      ok: false,
      refusal: 'NO_SUCH_TRANSITION',
      message: `A purchase order cannot go from ${from} to ${to}`,
    };
  }
  if (!ctx.permissions.includes(rule.permission)) {
    return {
      ok: false,
      refusal: 'FORBIDDEN',
      message: `You need ${rule.permission} to ${rule.action} this purchase order`,
      rule,
    };
  }
  if (reasonRequired(rule, from) && !ctx.reason?.trim()) {
    return {
      ok: false,
      refusal: 'REASON_REQUIRED',
      message: `A reason is required to ${rule.action} this purchase order`,
      rule,
    };
  }
  const why = rule.guard?.(ctx) ?? null;
  if (why) return { ok: false, refusal: 'GUARD_FAILED', message: why, rule };
  return { ok: true, rule };
}

/**
 * What this actor could do to this PO now — the PO screen's buttons. `receive` is never offered:
 * it is what a goods receipt does, not something pressed on the PO.
 */
export function availablePoActions(
  from: PoStatus,
  ctx: PoTransitionContext,
): { action: PoAction; to: PoStatus; requiresReason: boolean }[] {
  return (PO_TRANSITIONS as readonly PoTransitionRule[])
    .filter((r) => r.from.includes(from) && r.action !== 'receive')
    .flatMap((r) => {
      const v = canMovePo(from, r.to, { ...ctx, reason: ctx.reason ?? 'x' });
      if (!v.ok) return [];
      return [{ action: r.action, to: r.to, requiresReason: reasonRequired(r, from) }];
    });
}

// ─── Line counters ──────────────────────────────────────────────────────────────────────

export interface PoLineQuantities {
  qtyBase: number;
  qtyReceivedBase: number;
  qtyCancelledBase: number;
}

/** What is still to come on a line: ordered − received − cancelled. */
export const poLineOutstanding = (l: PoLineQuantities) =>
  l.qtyBase - l.qtyReceivedBase - l.qtyCancelledBase;

/** Why a line's counters are impossible, or null. Checked after every write that moves them. */
export function poLineInvariantViolation(l: PoLineQuantities): string | null {
  const counters = {
    qtyBase: l.qtyBase,
    qtyReceivedBase: l.qtyReceivedBase,
    qtyCancelledBase: l.qtyCancelledBase,
  };
  for (const [k, v] of Object.entries(counters)) {
    if (!Number.isInteger(v) || v < 0) return `${k} must be a whole number, not negative`;
  }
  if (l.qtyReceivedBase + l.qtyCancelledBase > l.qtyBase) {
    return 'received + cancelled exceeds what was ordered';
  }
  return null;
}

export function poTotals(lines: readonly PoLineQuantities[]) {
  return lines.reduce(
    (t, l) => ({
      orderedBase: t.orderedBase + l.qtyBase,
      receivedBase: t.receivedBase + l.qtyReceivedBase,
      cancelledBase: t.cancelledBase + l.qtyCancelledBase,
      outstandingBase: t.outstandingBase + poLineOutstanding(l),
    }),
    { orderedBase: 0, receivedBase: 0, cancelledBase: 0, outstandingBase: 0 },
  );
}

/** Where a receipt leaves a PO: what the `receive` edge lands on. */
export const statusAfterReceipt = (lines: readonly PoLineQuantities[]): PoStatus =>
  poTotals(lines).outstandingBase === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
