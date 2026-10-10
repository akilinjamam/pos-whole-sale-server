import { describe, expect, it } from 'vitest';

import {
  availablePoActions,
  canMovePo,
  INITIAL_PO_STATUS,
  PO_TRANSITIONS,
  poLineInvariantViolation,
  poLineOutstanding,
  poTotals,
  statusAfterReceipt,
  TERMINAL_PO_STATUSES,
} from '../src/domain/poStateMachine.js';
import { PO_STATUSES } from '../src/shared/enums.js';
import { ALL_PERMISSIONS } from '../src/shared/permissions.js';

import type { PoTransitionContext } from '../src/domain/poStateMachine.js';
import type { PoStatus } from '../src/shared/enums.js';
import type { Permission } from '../src/shared/permissions.js';

/** Day 32: the purchase order lifecycle, every edge and every refusal. */

const ctx = (over: Partial<PoTransitionContext> = {}): PoTransitionContext => ({
  permissions: ALL_PERMISSIONS,
  lineCount: 2,
  receivedBase: 0,
  outstandingBase: 100,
  reason: 'ZZTEST because',
  ...over,
});

const LEGAL = [
  'DRAFT>APPROVED',
  'DRAFT>CANCELLED',
  'APPROVED>DRAFT',
  'APPROVED>SENT',
  'APPROVED>PARTIALLY_RECEIVED',
  'APPROVED>RECEIVED',
  'APPROVED>CANCELLED',
  'SENT>PARTIALLY_RECEIVED',
  'SENT>RECEIVED',
  'SENT>CANCELLED',
  'PARTIALLY_RECEIVED>PARTIALLY_RECEIVED',
  'PARTIALLY_RECEIVED>RECEIVED',
  'PARTIALLY_RECEIVED>SHORT_CLOSED',
  'PARTIALLY_RECEIVED>CANCELLED', // only to refuse it with a useful message
];

describe('the transition table', () => {
  it('has exactly the legal edges — no more, no fewer', () => {
    const edges = PO_TRANSITIONS.flatMap((r) => r.from.map((f) => `${f}>${r.to}`));
    expect(edges.sort()).toEqual([...LEGAL].sort());
  });

  it('starts every PO in DRAFT and lets nothing leave a terminal status', () => {
    expect(INITIAL_PO_STATUS).toBe('DRAFT');
    for (const t of TERMINAL_PO_STATUSES) {
      expect(PO_TRANSITIONS.some((r) => (r.from as readonly PoStatus[]).includes(t))).toBe(
        false,
      );
    }
  });

  it('reaches every status from DRAFT', () => {
    const seen = new Set<PoStatus>(['DRAFT']);
    for (let changed = true; changed;) {
      changed = false;
      for (const r of PO_TRANSITIONS) {
        if (r.from.some((f) => seen.has(f)) && !seen.has(r.to)) {
          seen.add(r.to);
          changed = true;
        }
      }
    }
    expect([...seen].sort()).toEqual([...PO_STATUSES].sort());
  });
});

describe('canMovePo — all 49 pairs', () => {
  for (const from of PO_STATUSES) {
    for (const to of PO_STATUSES) {
      const legal = LEGAL.includes(`${from}>${to}`);
      it(`${from} → ${to}: ${legal ? 'an edge' : 'refused'}`, () => {
        const v = canMovePo(from, to, ctx());
        if (!legal) expect(v).toMatchObject({ ok: false, refusal: 'NO_SUCH_TRANSITION' });
        else expect(v.ok || v.refusal !== 'NO_SUCH_TRANSITION').toBe(true);
      });
    }
  }
});

describe('permissions', () => {
  const only = (...p: Permission[]) => ctx({ permissions: p });

  it('raising a PO is not approving it', () => {
    expect(canMovePo('DRAFT', 'APPROVED', only('po:create', 'po:update'))).toMatchObject({
      ok: false,
      refusal: 'FORBIDDEN',
      message: 'You need po:approve to approve this purchase order',
    });
    expect(canMovePo('DRAFT', 'APPROVED', only('po:approve')).ok).toBe(true);
  });

  it('receiving needs grn:create — the store keeper, not the buyer', () => {
    const r = ctx({ receivedBase: 10, outstandingBase: 90 });
    expect(
      canMovePo('SENT', 'PARTIALLY_RECEIVED', { ...r, permissions: ['po:update'] }).ok,
    ).toBe(false);
    expect(
      canMovePo('SENT', 'PARTIALLY_RECEIVED', { ...r, permissions: ['grn:create'] }).ok,
    ).toBe(true);
  });

  it('cancel and short close each need their own grant', () => {
    expect(canMovePo('SENT', 'CANCELLED', only('po:update')).ok).toBe(false);
    expect(
      canMovePo('PARTIALLY_RECEIVED', 'SHORT_CLOSED', {
        ...only('po:cancel'),
        receivedBase: 5,
        outstandingBase: 5,
      }).ok,
    ).toBe(false);
  });
});

describe('guards', () => {
  it('approval needs at least one line', () => {
    expect(canMovePo('DRAFT', 'APPROVED', ctx({ lineCount: 0 }))).toMatchObject({
      refusal: 'GUARD_FAILED',
      message: 'The purchase order has no lines',
    });
  });

  it('a receipt lands on PARTIALLY_RECEIVED or RECEIVED by what is left, never the other', () => {
    const part = ctx({ receivedBase: 40, outstandingBase: 60 });
    const all = ctx({ receivedBase: 100, outstandingBase: 0 });
    expect(canMovePo('SENT', 'PARTIALLY_RECEIVED', part).ok).toBe(true);
    expect(canMovePo('SENT', 'RECEIVED', part).ok).toBe(false);
    expect(canMovePo('PARTIALLY_RECEIVED', 'RECEIVED', all).ok).toBe(true);
    expect(canMovePo('PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED', all).ok).toBe(false);
  });

  it('a receipt that received nothing is refused', () => {
    expect(canMovePo('SENT', 'PARTIALLY_RECEIVED', ctx())).toMatchObject({
      refusal: 'GUARD_FAILED',
    });
  });

  it('cancel is refused once anything has been received — that is a short close', () => {
    expect(
      canMovePo(
        'PARTIALLY_RECEIVED',
        'CANCELLED',
        ctx({ receivedBase: 1, outstandingBase: 99 }),
      ),
    ).toMatchObject({ refusal: 'GUARD_FAILED', message: /short-close it instead/ });
    expect(
      canMovePo('SENT', 'CANCELLED', ctx({ receivedBase: 1, outstandingBase: 99 })),
    ).toMatchObject({
      refusal: 'GUARD_FAILED',
      message: 'Goods have been received against it — short-close it instead',
    });
  });
});

describe('reasons', () => {
  it('cancelling an approved or sent PO, reopening and short closing need one', () => {
    const none = ctx({ reason: null, receivedBase: 5, outstandingBase: 5 });
    expect(canMovePo('APPROVED', 'CANCELLED', { ...none, receivedBase: 0 })).toMatchObject({
      refusal: 'REASON_REQUIRED',
    });
    expect(canMovePo('APPROVED', 'DRAFT', none)).toMatchObject({ refusal: 'REASON_REQUIRED' });
    expect(canMovePo('PARTIALLY_RECEIVED', 'SHORT_CLOSED', none)).toMatchObject({
      refusal: 'REASON_REQUIRED',
    });
  });

  it('cancelling a draft, approving and sending do not', () => {
    const none = ctx({ reason: null });
    expect(canMovePo('DRAFT', 'CANCELLED', none).ok).toBe(true);
    expect(canMovePo('DRAFT', 'APPROVED', none).ok).toBe(true);
    expect(canMovePo('APPROVED', 'SENT', none).ok).toBe(true);
  });
});

describe('availablePoActions — the PO screen’s buttons', () => {
  it('a draft: approve or cancel', () => {
    expect(availablePoActions('DRAFT', ctx()).map((a) => a.action)).toEqual([
      'approve',
      'cancel',
    ]);
  });

  it('an approved PO: reopen, send or cancel — never "receive", which a GRN does', () => {
    expect(availablePoActions('APPROVED', ctx())).toEqual([
      { action: 'reopen', to: 'DRAFT', requiresReason: true },
      { action: 'send', to: 'SENT', requiresReason: false },
      { action: 'cancel', to: 'CANCELLED', requiresReason: true },
    ]);
  });

  it('a buyer without po:approve is not offered approve', () => {
    expect(
      availablePoActions('DRAFT', ctx({ permissions: ['po:update', 'po:cancel'] })).map(
        (a) => a.action,
      ),
    ).toEqual(['cancel']);
  });

  it('nothing on a terminal PO', () => {
    for (const t of TERMINAL_PO_STATUSES) expect(availablePoActions(t, ctx())).toEqual([]);
  });
});

describe('line counters', () => {
  const l = { qtyBase: 100, qtyReceivedBase: 30, qtyCancelledBase: 20 };

  it('outstanding is ordered − received − cancelled; totals add up', () => {
    expect(poLineOutstanding(l)).toBe(50);
    expect(poTotals([l, { qtyBase: 10, qtyReceivedBase: 10, qtyCancelledBase: 0 }])).toEqual({
      orderedBase: 110,
      receivedBase: 40,
      cancelledBase: 20,
      outstandingBase: 50,
    });
  });

  it('refuses impossible counters', () => {
    expect(poLineInvariantViolation(l)).toBeNull();
    expect(poLineInvariantViolation({ ...l, qtyReceivedBase: 81 })).toMatch(/exceeds/);
    expect(poLineInvariantViolation({ ...l, qtyCancelledBase: -1 })).toMatch(/not negative/);
  });

  it('statusAfterReceipt reads where the lines leave it', () => {
    expect(statusAfterReceipt([l])).toBe('PARTIALLY_RECEIVED');
    expect(statusAfterReceipt([{ ...l, qtyReceivedBase: 80 }])).toBe('RECEIVED');
  });
});
