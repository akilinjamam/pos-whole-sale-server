/**
 * The wholesale order state machine — §7 of the project plan. Pure: no database, no clock.
 *
 * One coarse `status`, moved only along the edges in `TRANSITIONS`. `wholesaleOrder.service`
 * calls `can()` before every status write and appends the result to `statusHistory`; the model
 * refuses any status write that did not come through it. So the table below is not
 * documentation of the lifecycle — it *is* the lifecycle, and a unit test walks every pair.
 *
 * Fulfilment and billing are deliberately **not** in this machine: they are rollups of the line
 * counters (`domain/orderQuantities.ts`). A single linear enum cannot say "fully dispatched, half
 * invoiced", and payment status lives on the invoice, not the order.
 *
 *   DRAFT ─confirm─► CONFIRMED ─startPicking─► PICKING ─pack─► PACKED ─dispatch─► PARTIALLY_DISPATCHED
 *     │  └─submit─► PENDING_APPROVAL ─approve─┘                    │                 │    ▲  │
 *     │             └─reject─► DRAFT                               │                 │    └──┘ (another challan)
 *     │                                                            └─dispatch─► DISPATCHED ◄─┘
 *     │                                                                          │ deliver
 *     └─cancel─► CANCELLED  (from anything before the first posted dispatch)     ▼
 *                                                                            DELIVERED ─close─► CLOSED
 *   PICKING / PACKED / PARTIALLY_DISPATCHED ─shortClose─► CLOSED  (after a posted dispatch)
 */

import type { CreditCheckStatus, OrderStatus } from '@shared/enums.js';
import type { Permission } from '@shared/permissions.js';

/** Every order starts here. Creation is recorded in `statusHistory` as `from: null`. */
export const INITIAL_ORDER_STATUS = 'DRAFT' satisfies OrderStatus;

/** No edge leaves these. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ['CANCELLED', 'CLOSED'];

/**
 * What a guard may look at. The service builds it from the order **as it will be once the
 * transition's own quantity effects are applied** — a dispatch `$inc`s `qtyDispatchedBase` and a
 * short close sets `qtyCancelledBase` in the same transaction *before* asking whether the move is
 * legal, so the guard judges the order the transition leaves behind.
 */
export interface OrderTransitionContext {
  /** The actor's effective permissions. */
  permissions: readonly Permission[];
  lineCount: number;
  /** Σ lines.qtyDispatchedBase. */
  dispatchedBase: number;
  /** Σ (qtyBase − qtyDispatchedBase − qtyCancelledBase): what is still to ship. */
  outstandingBase: number;
  /** `order.creditCheck.status`, or null if the check has not run. */
  creditCheck: CreditCheckStatus | null;
  /** The typed reason, where the edge demands one. */
  reason?: string | null;
}

/** The verbs of the lifecycle. The client shows these as buttons; the history records them. */
export type OrderAction =
  | 'confirm'
  | 'submitForApproval'
  | 'approve'
  | 'reject'
  | 'startPicking'
  | 'pack'
  | 'dispatch'
  | 'deliver'
  | 'close'
  | 'cancel'
  | 'shortClose';

type Guard = (ctx: OrderTransitionContext) => string | null;

export interface OrderTransitionRule {
  action: OrderAction;
  from: readonly OrderStatus[];
  to: OrderStatus;
  permission: Permission;
  /**
   * Returns why the move is refused, or null. Guards cover only what the order itself can
   * answer; conditions that need the database — stock available to reserve, a dealer on hold —
   * are enforced by the service inside the same transaction.
   */
  guard?: Guard;
  /** Whether a typed reason is mandatory — as a function where it depends on the source state. */
  requiresReason?: boolean | ((from: OrderStatus) => boolean);
}

// ─── Guards ─────────────────────────────────────────────────────────────────────────────

const hasLines: Guard = (c) => (c.lineCount > 0 ? null : 'The order has no lines');

const creditCleared: Guard = (c) =>
  c.creditCheck === 'OK' || c.creditCheck === 'OVERRIDDEN'
    ? null
    : c.creditCheck === 'BLOCKED'
      ? 'The credit check failed — the order needs approval'
      : 'The credit check has not been run';

const all =
  (...guards: Guard[]): Guard =>
  (c) => {
    for (const g of guards) {
      const why = g(c);
      if (why) return why;
    }
    return null;
  };

const nothingDispatched: Guard = (c) =>
  c.dispatchedBase === 0
    ? null
    : 'Goods have already been dispatched against this order — short-close it instead';

const somethingDispatched: Guard = (c) =>
  c.dispatchedBase > 0 ? null : 'Nothing has been dispatched yet — cancel the order instead';

const stillOutstanding: Guard = (c) =>
  c.outstandingBase > 0 ? null : 'Every line has been dispatched';

const nothingOutstanding: Guard = (c) =>
  c.outstandingBase === 0 ? null : 'Lines remain to be dispatched';

// ─── The table ──────────────────────────────────────────────────────────────────────────

export const TRANSITIONS = [
  {
    action: 'confirm',
    from: ['DRAFT'],
    to: 'CONFIRMED',
    permission: 'order:confirm',
    guard: all(hasLines, creditCleared),
  },
  {
    // Only when the credit check fails and the confirming user cannot override it (§7).
    action: 'submitForApproval',
    from: ['DRAFT'],
    to: 'PENDING_APPROVAL',
    permission: 'order:confirm',
    guard: all(hasLines, (c) =>
      c.creditCheck === 'BLOCKED' ? null : 'Only an order blocked on credit needs approval',
    ),
  },
  {
    action: 'approve',
    from: ['PENDING_APPROVAL'],
    to: 'CONFIRMED',
    permission: 'order:approve',
    guard: all(hasLines, creditCleared),
    requiresReason: true,
  },
  {
    // Back to the rep to amend — fewer lines, a smaller order, a cash advance first.
    action: 'reject',
    from: ['PENDING_APPROVAL'],
    to: 'DRAFT',
    permission: 'order:approve',
    requiresReason: true,
  },
  {
    action: 'startPicking',
    from: ['CONFIRMED'],
    to: 'PICKING',
    permission: 'dispatch:create',
  },
  {
    // The next round of a partially shipped order.
    action: 'startPicking',
    from: ['PARTIALLY_DISPATCHED'],
    to: 'PICKING',
    permission: 'dispatch:create',
    guard: stillOutstanding,
  },
  {
    action: 'pack',
    from: ['PICKING'],
    to: 'PACKED',
    permission: 'dispatch:pack',
  },
  {
    // PARTIALLY_DISPATCHED → PARTIALLY_DISPATCHED is a real edge: two challans packed together
    // post one after the other, and each is a line in the order's timeline.
    action: 'dispatch',
    from: ['PACKED', 'PARTIALLY_DISPATCHED'],
    to: 'PARTIALLY_DISPATCHED',
    permission: 'dispatch:post',
    guard: all(somethingDispatched, stillOutstanding),
  },
  {
    action: 'dispatch',
    from: ['PACKED', 'PARTIALLY_DISPATCHED'],
    to: 'DISPATCHED',
    permission: 'dispatch:post',
    guard: all(somethingDispatched, nothingOutstanding),
  },
  {
    action: 'deliver',
    from: ['DISPATCHED'],
    to: 'DELIVERED',
    permission: 'dispatch:deliver',
  },
  {
    action: 'close',
    from: ['DELIVERED'],
    to: 'CLOSED',
    permission: 'order:update',
  },
  {
    // A draft is nobody's commitment yet; cancelling anything past it needs a reason on record.
    action: 'cancel',
    from: ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED'],
    to: 'CANCELLED',
    permission: 'order:cancel',
    guard: nothingDispatched,
    requiresReason: (from) => from !== 'DRAFT',
  },
  {
    // "Ship what we have, forget the rest": `qtyCancelledBase = remaining`, reservations released.
    action: 'shortClose',
    from: ['PICKING', 'PACKED', 'PARTIALLY_DISPATCHED'],
    to: 'CLOSED',
    permission: 'order:shortClose',
    guard: somethingDispatched,
    requiresReason: true,
  },
] as const satisfies readonly OrderTransitionRule[];

// Index once: (from, to) → rule. Two rules for the same pair would make `can` ambiguous, so
// that is an error at module load rather than a silent "first one wins".
const BY_EDGE = new Map<string, OrderTransitionRule>();
for (const rule of TRANSITIONS as readonly OrderTransitionRule[]) {
  for (const from of rule.from) {
    const key = `${from}>${rule.to}`;
    if (BY_EDGE.has(key)) throw new Error(`Duplicate order transition ${key}`);
    BY_EDGE.set(key, rule);
  }
}

/** The rule for an edge, or undefined if the machine has no such edge. */
export function ruleFor(from: OrderStatus, to: OrderStatus): OrderTransitionRule | undefined {
  return BY_EDGE.get(`${from}>${to}`);
}

function reasonRequired(rule: OrderTransitionRule, from: OrderStatus): boolean {
  return typeof rule.requiresReason === 'function'
    ? rule.requiresReason(from)
    : (rule.requiresReason ?? false);
}

// ─── Evaluation ─────────────────────────────────────────────────────────────────────────

export type TransitionRefusal =
  /** No such edge. Maps to 409 ILLEGAL_TRANSITION. */
  | 'NO_SUCH_TRANSITION'
  /** The edge exists but the order is not in a state to take it. 409 ILLEGAL_TRANSITION. */
  | 'GUARD_FAILED'
  /** The actor lacks the edge's permission. 403. */
  | 'FORBIDDEN'
  /** The edge needs a typed reason and none was given. 422. */
  | 'REASON_REQUIRED';

export type TransitionVerdict =
  | { ok: true; rule: OrderTransitionRule }
  | { ok: false; refusal: TransitionRefusal; message: string; rule?: OrderTransitionRule };

/**
 * Whether the order may move `from` → `to`. Checks, in order: the edge exists, the actor holds
 * its permission, a reason is present where one is required, and the guard passes.
 */
export function can(
  from: OrderStatus,
  to: OrderStatus,
  ctx: OrderTransitionContext,
): TransitionVerdict {
  const rule = ruleFor(from, to);
  if (!rule) {
    return {
      ok: false,
      refusal: 'NO_SUCH_TRANSITION',
      message: `An order cannot go from ${from} to ${to}`,
    };
  }
  if (!ctx.permissions.includes(rule.permission)) {
    return {
      ok: false,
      refusal: 'FORBIDDEN',
      message: `You need ${rule.permission} to ${rule.action} this order`,
      rule,
    };
  }
  if (reasonRequired(rule, from) && !ctx.reason?.trim()) {
    return {
      ok: false,
      refusal: 'REASON_REQUIRED',
      message: `A reason is required to ${rule.action} this order`,
      rule,
    };
  }
  const why = rule.guard?.(ctx) ?? null;
  if (why) return { ok: false, refusal: 'GUARD_FAILED', message: why, rule };
  return { ok: true, rule };
}

/** Every status reachable from `from` by some edge, ignoring guards and permissions. */
export function nextStatuses(from: OrderStatus): OrderStatus[] {
  return (TRANSITIONS as readonly OrderTransitionRule[])
    .filter((r) => r.from.includes(from))
    .map((r) => r.to);
}

/**
 * What this actor could do to this order right now — the buttons on the order screen. A
 * transition that only lacks a reason is offered: the UI asks for one.
 */
export function availableActions(
  from: OrderStatus,
  ctx: OrderTransitionContext,
): { action: OrderAction; to: OrderStatus; requiresReason: boolean }[] {
  return nextStatuses(from).flatMap((to) => {
    const v = can(from, to, { ...ctx, reason: ctx.reason ?? 'x' });
    if (!v.ok) return [];
    return [{ action: v.rule.action, to, requiresReason: reasonRequired(v.rule, from) }];
  });
}
