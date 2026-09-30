import { describe, expect, it } from 'vitest';

import {
  availableActions,
  can,
  INITIAL_ORDER_STATUS,
  nextStatuses,
  TERMINAL_ORDER_STATUSES,
  TRANSITIONS,
} from '../src/domain/orderStateMachine.js';
import {
  billingStatusOf,
  fulfillmentStatusOf,
  lineInvariantViolation,
  lineOutstanding,
  orderTotals,
} from '../src/domain/orderQuantities.js';
import { ORDER_STATUSES } from '../src/shared/enums.js';
import { ALL_PERMISSIONS } from '../src/shared/permissions.js';

import type { OrderTransitionContext } from '../src/domain/orderStateMachine.js';
import type { OrderStatus } from '../src/shared/enums.js';
import type { Permission } from '../src/shared/permissions.js';

/**
 * Day 21: every legal and every illegal transition of the wholesale order.
 *
 * The legal edges are written out again here, by hand, from §7 of the project plan — *not*
 * derived from `TRANSITIONS`. A test that reads the table it is testing would pass whatever the
 * table said. Every one of the 100 (from, to) pairs is then checked against this list.
 */

type Edge = [from: OrderStatus, to: OrderStatus, action: string];

const LEGAL: Edge[] = [
  ['DRAFT', 'CONFIRMED', 'confirm'],
  ['DRAFT', 'PENDING_APPROVAL', 'submitForApproval'],
  ['DRAFT', 'CANCELLED', 'cancel'],
  ['PENDING_APPROVAL', 'CONFIRMED', 'approve'],
  ['PENDING_APPROVAL', 'DRAFT', 'reject'],
  ['PENDING_APPROVAL', 'CANCELLED', 'cancel'],
  ['CONFIRMED', 'PICKING', 'startPicking'],
  ['CONFIRMED', 'CANCELLED', 'cancel'],
  ['PICKING', 'PACKED', 'pack'],
  ['PICKING', 'CANCELLED', 'cancel'],
  ['PICKING', 'CLOSED', 'shortClose'],
  ['PACKED', 'PARTIALLY_DISPATCHED', 'dispatch'],
  ['PACKED', 'DISPATCHED', 'dispatch'],
  ['PACKED', 'CANCELLED', 'cancel'],
  ['PACKED', 'CLOSED', 'shortClose'],
  ['PARTIALLY_DISPATCHED', 'PARTIALLY_DISPATCHED', 'dispatch'],
  ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'dispatch'],
  ['PARTIALLY_DISPATCHED', 'PICKING', 'startPicking'],
  ['PARTIALLY_DISPATCHED', 'CLOSED', 'shortClose'],
  ['DISPATCHED', 'DELIVERED', 'deliver'],
  ['DELIVERED', 'CLOSED', 'close'],
];

const legalKey = new Set(LEGAL.map(([f, t]) => `${f}>${t}`));

/** A context in which the edge `from → to` should pass — the happy path for that edge. */
function passingCtx(from: OrderStatus, to: OrderStatus): OrderTransitionContext {
  const base: OrderTransitionContext = {
    permissions: ALL_PERMISSIONS,
    lineCount: 2,
    dispatchedBase: 0,
    outstandingBase: 10,
    creditCheck: 'OK',
    reason: 'because',
  };
  if (from === 'DRAFT' && to === 'PENDING_APPROVAL') return { ...base, creditCheck: 'BLOCKED' };
  if (to === 'PARTIALLY_DISPATCHED') return { ...base, dispatchedBase: 4, outstandingBase: 6 };
  if (to === 'DISPATCHED') return { ...base, dispatchedBase: 10, outstandingBase: 0 };
  if (from === 'PARTIALLY_DISPATCHED')
    return { ...base, dispatchedBase: 4, outstandingBase: 6 };
  if (to === 'CLOSED' && from !== 'DELIVERED')
    return { ...base, dispatchedBase: 4, outstandingBase: 0 };
  if (from === 'DISPATCHED' || from === 'DELIVERED') {
    return { ...base, dispatchedBase: 10, outstandingBase: 0 };
  }
  return base;
}

const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));

describe('the transition table', () => {
  it('has exactly the legal edges of §7 — no more, no fewer', () => {
    const actual = TRANSITIONS.flatMap((r) => r.from.map((f) => `${f}>${r.to}`)).sort();
    expect(actual).toEqual([...legalKey].sort());
  });

  it('starts every order in DRAFT', () => {
    expect(INITIAL_ORDER_STATUS).toBe('DRAFT');
  });

  it('lets nothing leave a terminal status', () => {
    for (const s of TERMINAL_ORDER_STATUSES) expect(nextStatuses(s)).toEqual([]);
  });

  it('lets every non-terminal status reach a terminal one', () => {
    const reaches = (from: OrderStatus, seen = new Set<OrderStatus>()): boolean => {
      if (TERMINAL_ORDER_STATUSES.includes(from)) return true;
      seen.add(from);
      return nextStatuses(from).some((n) => !seen.has(n) && reaches(n, seen));
    };
    for (const s of ORDER_STATUSES) expect(reaches(s), s).toBe(true);
  });

  it('has no status that cannot be reached from DRAFT', () => {
    const seen = new Set<OrderStatus>(['DRAFT']);
    const queue: OrderStatus[] = ['DRAFT'];
    while (queue.length) {
      for (const n of nextStatuses(queue.shift()!)) {
        if (!seen.has(n)) (seen.add(n), queue.push(n));
      }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});

describe('can(from, to) — all 100 pairs', () => {
  it.each(pairs.filter(([f, t]) => legalKey.has(`${f}>${t}`)))('allows %s → %s', (from, to) => {
    const v = can(from, to, passingCtx(from, to));
    expect(v.ok, v.ok ? '' : v.message).toBe(true);
    const expected = LEGAL.find(([f, t]) => f === from && t === to)![2];
    if (v.ok) expect(v.rule.action).toBe(expected);
  });

  it.each(pairs.filter(([f, t]) => !legalKey.has(`${f}>${t}`)))(
    'refuses %s → %s as NO_SUCH_TRANSITION',
    (from, to) => {
      // Even with every permission, a reason, and counters that would satisfy any guard.
      const v = can(from, to, passingCtx(from, to));
      expect(v).toMatchObject({ ok: false, refusal: 'NO_SUCH_TRANSITION' });
    },
  );
});

describe('permissions', () => {
  const needs: [OrderStatus, OrderStatus, Permission][] = [
    ['DRAFT', 'CONFIRMED', 'order:confirm'],
    ['DRAFT', 'PENDING_APPROVAL', 'order:confirm'],
    ['PENDING_APPROVAL', 'CONFIRMED', 'order:approve'],
    ['PENDING_APPROVAL', 'DRAFT', 'order:approve'],
    ['CONFIRMED', 'PICKING', 'dispatch:create'],
    ['PICKING', 'PACKED', 'dispatch:pack'],
    ['PACKED', 'DISPATCHED', 'dispatch:post'],
    ['DISPATCHED', 'DELIVERED', 'dispatch:deliver'],
    ['DELIVERED', 'CLOSED', 'order:update'],
    ['CONFIRMED', 'CANCELLED', 'order:cancel'],
    ['PARTIALLY_DISPATCHED', 'CLOSED', 'order:shortClose'],
  ];

  it.each(needs)('%s → %s needs %s', (from, to, permission) => {
    const ctx = passingCtx(from, to);
    const without = ctx.permissions.filter((p) => p !== permission);
    expect(can(from, to, { ...ctx, permissions: without })).toMatchObject({
      ok: false,
      refusal: 'FORBIDDEN',
    });
    expect(can(from, to, { ...ctx, permissions: [permission] }).ok).toBe(true);
  });

  it('a sales rep can confirm but not approve their own blocked order', () => {
    const rep: Permission[] = ['order:read', 'order:create', 'order:update', 'order:confirm'];
    expect(
      can('DRAFT', 'PENDING_APPROVAL', {
        ...passingCtx('DRAFT', 'PENDING_APPROVAL'),
        permissions: rep,
      }).ok,
    ).toBe(true);
    expect(
      can('PENDING_APPROVAL', 'CONFIRMED', {
        ...passingCtx('PENDING_APPROVAL', 'CONFIRMED'),
        permissions: rep,
      }),
    ).toMatchObject({ ok: false, refusal: 'FORBIDDEN' });
  });
});

describe('guards', () => {
  const ok = passingCtx;

  it('confirm needs at least one line', () => {
    expect(
      can('DRAFT', 'CONFIRMED', { ...ok('DRAFT', 'CONFIRMED'), lineCount: 0 }),
    ).toMatchObject({
      ok: false,
      refusal: 'GUARD_FAILED',
      message: 'The order has no lines',
    });
  });

  it('confirm needs a credit check that passed or was overridden', () => {
    const c = ok('DRAFT', 'CONFIRMED');
    expect(can('DRAFT', 'CONFIRMED', { ...c, creditCheck: 'OVERRIDDEN' }).ok).toBe(true);
    expect(can('DRAFT', 'CONFIRMED', { ...c, creditCheck: 'BLOCKED' })).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
    expect(can('DRAFT', 'CONFIRMED', { ...c, creditCheck: null })).toMatchObject({
      refusal: 'GUARD_FAILED',
      message: 'The credit check has not been run',
    });
  });

  it('only a credit-blocked order goes to approval', () => {
    const c = ok('DRAFT', 'PENDING_APPROVAL');
    expect(can('DRAFT', 'PENDING_APPROVAL', { ...c, creditCheck: 'OK' })).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
    expect(can('DRAFT', 'PENDING_APPROVAL', { ...c, lineCount: 0 })).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
  });

  it('approval needs the block to have been overridden', () => {
    const c = ok('PENDING_APPROVAL', 'CONFIRMED');
    expect(
      can('PENDING_APPROVAL', 'CONFIRMED', { ...c, creditCheck: 'BLOCKED' }),
    ).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
    expect(can('PENDING_APPROVAL', 'CONFIRMED', { ...c, creditCheck: 'OVERRIDDEN' }).ok).toBe(
      true,
    );
  });

  it('a dispatch lands on PARTIALLY_DISPATCHED or DISPATCHED by what is left, never the other', () => {
    for (const from of ['PACKED', 'PARTIALLY_DISPATCHED'] as const) {
      const partial = { ...ok(from, 'DISPATCHED'), dispatchedBase: 4, outstandingBase: 6 };
      const full = { ...ok(from, 'DISPATCHED'), dispatchedBase: 10, outstandingBase: 0 };
      expect(can(from, 'PARTIALLY_DISPATCHED', partial).ok).toBe(true);
      expect(can(from, 'DISPATCHED', partial)).toMatchObject({ refusal: 'GUARD_FAILED' });
      expect(can(from, 'DISPATCHED', full).ok).toBe(true);
      expect(can(from, 'PARTIALLY_DISPATCHED', full)).toMatchObject({
        refusal: 'GUARD_FAILED',
      });
    }
  });

  it('a dispatch that dispatched nothing is refused', () => {
    const c = { ...ok('PACKED', 'DISPATCHED'), dispatchedBase: 0, outstandingBase: 10 };
    expect(can('PACKED', 'PARTIALLY_DISPATCHED', c)).toMatchObject({ refusal: 'GUARD_FAILED' });
  });

  it('picking again after a partial dispatch needs something left to pick', () => {
    const c = ok('PARTIALLY_DISPATCHED', 'PICKING');
    expect(can('PARTIALLY_DISPATCHED', 'PICKING', { ...c, outstandingBase: 0 })).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
  });

  it('cancel is refused once anything has been dispatched — that is a short close', () => {
    for (const from of [
      'DRAFT',
      'PENDING_APPROVAL',
      'CONFIRMED',
      'PICKING',
      'PACKED',
    ] as const) {
      const c = { ...ok(from, 'CANCELLED'), dispatchedBase: 1 };
      expect(can(from, 'CANCELLED', c)).toMatchObject({ refusal: 'GUARD_FAILED' });
    }
  });

  it('short close is refused when nothing has been dispatched — that is a cancel', () => {
    for (const from of ['PICKING', 'PACKED', 'PARTIALLY_DISPATCHED'] as const) {
      const c = { ...ok(from, 'CLOSED'), dispatchedBase: 0 };
      expect(can(from, 'CLOSED', c)).toMatchObject({ refusal: 'GUARD_FAILED' });
    }
  });
});

describe('reasons', () => {
  const noReason = (from: OrderStatus, to: OrderStatus) => ({
    ...passingCtx(from, to),
    reason: '  ',
  });

  it.each([
    ['PENDING_APPROVAL', 'CONFIRMED'],
    ['PENDING_APPROVAL', 'DRAFT'],
    ['PENDING_APPROVAL', 'CANCELLED'],
    ['CONFIRMED', 'CANCELLED'],
    ['PICKING', 'CANCELLED'],
    ['PACKED', 'CANCELLED'],
    ['PARTIALLY_DISPATCHED', 'CLOSED'],
  ] as const)('%s → %s needs a reason', (from, to) => {
    expect(can(from, to, noReason(from, to))).toMatchObject({ refusal: 'REASON_REQUIRED' });
  });

  it('cancelling a draft does not — it was nobody’s commitment yet', () => {
    expect(can('DRAFT', 'CANCELLED', noReason('DRAFT', 'CANCELLED')).ok).toBe(true);
  });

  it('routine moves do not', () => {
    expect(can('CONFIRMED', 'PICKING', noReason('CONFIRMED', 'PICKING')).ok).toBe(true);
    expect(can('DELIVERED', 'CLOSED', noReason('DELIVERED', 'CLOSED')).ok).toBe(true);
  });
});

describe('availableActions — the order screen’s buttons', () => {
  it('offers a confirmed order to a manager: pick or cancel (with a reason)', () => {
    expect(availableActions('CONFIRMED', passingCtx('CONFIRMED', 'PICKING'))).toEqual([
      { action: 'startPicking', to: 'PICKING', requiresReason: false },
      { action: 'cancel', to: 'CANCELLED', requiresReason: true },
    ]);
  });

  it('offers a sales rep only what their permissions allow', () => {
    const ctx = {
      ...passingCtx('DRAFT', 'CONFIRMED'),
      permissions: ['order:confirm'] as Permission[],
    };
    expect(availableActions('DRAFT', ctx)).toEqual([
      { action: 'confirm', to: 'CONFIRMED', requiresReason: false },
    ]);
  });

  it('offers nothing on a terminal order', () => {
    expect(availableActions('CANCELLED', passingCtx('DRAFT', 'CONFIRMED'))).toEqual([]);
  });
});

describe('line counters and rollups', () => {
  const line = (over: Partial<Parameters<typeof lineOutstanding>[0]> = {}) => ({
    qtyBase: 10,
    qtyReservedBase: 0,
    qtyDispatchedBase: 0,
    qtyInvoicedBase: 0,
    qtyCancelledBase: 0,
    ...over,
  });

  it('outstanding is ordered − dispatched − cancelled', () => {
    expect(lineOutstanding(line({ qtyDispatchedBase: 4, qtyCancelledBase: 2 }))).toBe(4);
  });

  it('refuses impossible counters', () => {
    expect(lineInvariantViolation(line())).toBeNull();
    expect(lineInvariantViolation(line({ qtyReservedBase: 10 }))).toBeNull();
    expect(lineInvariantViolation(line({ qtyDispatchedBase: 8, qtyCancelledBase: 3 }))).toMatch(
      /exceeds the ordered/,
    );
    expect(lineInvariantViolation(line({ qtyDispatchedBase: 4, qtyReservedBase: 7 }))).toMatch(
      /Reserved/,
    );
    expect(lineInvariantViolation(line({ qtyDispatchedBase: 4, qtyInvoicedBase: 5 }))).toMatch(
      /Invoiced/,
    );
    expect(lineInvariantViolation(line({ qtyBase: 0 }))).toMatch(/at least 1/);
    expect(lineInvariantViolation(line({ qtyReservedBase: 1.5 }))).toMatch(/whole/);
  });

  it('fulfilment: NONE → PARTIAL → COMPLETE, and a short-closed remainder counts as settled', () => {
    expect(fulfillmentStatusOf([line(), line()])).toBe('NONE');
    expect(fulfillmentStatusOf([line({ qtyDispatchedBase: 10 }), line()])).toBe('PARTIAL');
    expect(
      fulfillmentStatusOf([line({ qtyDispatchedBase: 10 }), line({ qtyDispatchedBase: 10 })]),
    ).toBe('COMPLETE');
    expect(
      fulfillmentStatusOf([
        line({ qtyDispatchedBase: 10 }),
        line({ qtyDispatchedBase: 3, qtyCancelledBase: 7 }),
      ]),
    ).toBe('COMPLETE');
  });

  it('billing: against what will ship, not what was ordered', () => {
    expect(billingStatusOf([line()])).toBe('UNBILLED');
    expect(billingStatusOf([line({ qtyDispatchedBase: 4, qtyInvoicedBase: 4 })])).toBe(
      'PARTIAL',
    );
    expect(
      billingStatusOf([
        line({ qtyDispatchedBase: 4, qtyInvoicedBase: 4, qtyCancelledBase: 6 }),
      ]),
    ).toBe('BILLED');
  });

  it('totals add up across lines', () => {
    expect(
      orderTotals([
        line({ qtyReservedBase: 6, qtyDispatchedBase: 4 }),
        line({ qtyCancelledBase: 10 }),
      ]),
    ).toEqual({
      orderedBase: 20,
      reservedBase: 6,
      dispatchedBase: 4,
      invoicedBase: 0,
      cancelledBase: 10,
      outstandingBase: 6,
    });
  });
});
