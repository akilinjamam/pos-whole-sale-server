import { describe, expect, it } from 'vitest';

import { forbiddenChanges, gatedDealerChanges } from '../src/modules/party/party.rules.js';
import { createDealerSchema, formatPartyCode } from '../src/shared/party.js';

import type { GatedDealerValues } from '../src/modules/party/party.rules.js';

/**
 * The dealer credit gate, which is enforced in the service by rejecting the *change* — never by
 * hiding an input. These pin down what counts as a change, because getting that wrong in either
 * direction is a real failure: too eager, and a sales rep cannot save a phone number; too lax,
 * and they can raise their own dealer's limit.
 */

const current: GatedDealerValues = {
  creditLimitMinor: 5_000_000,
  paymentTermsDays: 30,
  creditHold: false,
  creditHoldReason: null,
};

describe('gatedDealerChanges', () => {
  it('reports nothing when no dealer terms were sent', () => {
    expect(gatedDealerChanges(current, undefined)).toEqual([]);
  });

  it('treats a PATCH that echoes the stored values as no change', () => {
    // What the editor sends when a rep fixes the territory and saves the whole form.
    expect(gatedDealerChanges(current, { ...current, territory: 'Chattogram' })).toEqual([]);
  });

  it('flags a changed limit and terms against dealer:setCreditLimit', () => {
    expect(
      gatedDealerChanges(current, { creditLimitMinor: 6_000_000, paymentTermsDays: 45 }),
    ).toEqual([
      { field: 'dealer.creditLimitMinor', permission: 'dealer:setCreditLimit' },
      { field: 'dealer.paymentTermsDays', permission: 'dealer:setCreditLimit' },
    ]);
  });

  it('flags a hold and its reason against dealer:creditHold', () => {
    expect(
      gatedDealerChanges(current, { creditHold: true, creditHoldReason: 'Cheque bounced' }),
    ).toEqual([
      { field: 'dealer.creditHold', permission: 'dealer:creditHold' },
      { field: 'dealer.creditHoldReason', permission: 'dealer:creditHold' },
    ]);
  });

  it('does not count an empty reason as a change from no reason', () => {
    expect(gatedDealerChanges(current, { creditHoldReason: '' })).toEqual([]);
    expect(gatedDealerChanges(current, { creditHoldReason: null })).toEqual([]);
  });

  it('ignores the ungated dealer fields entirely', () => {
    expect(
      gatedDealerChanges(current, { discountPct: 5, territory: 'Sylhet', since: '2024-01-01' }),
    ).toEqual([]);
  });
});

describe('forbiddenChanges', () => {
  const changes = gatedDealerChanges(current, {
    creditLimitMinor: 1,
    creditHold: true,
    creditHoldReason: 'x',
  });

  it('keeps only the changes the caller lacks the grant for', () => {
    // A SALES_REP: dealer:update, but neither credit grant.
    expect(forbiddenChanges(changes, ['dealer:update']).map((c) => c.field)).toEqual([
      'dealer.creditLimitMinor',
      'dealer.creditHold',
      'dealer.creditHoldReason',
    ]);
  });

  it('allows everything to a caller holding both grants', () => {
    // ACCOUNTS holds both.
    expect(forbiddenChanges(changes, ['dealer:setCreditLimit', 'dealer:creditHold'])).toEqual(
      [],
    );
  });
});

describe('party codes', () => {
  it('formats the generated sequence', () => {
    expect(formatPartyCode(1)).toBe('P-00001');
    expect(formatPartyCode(123456)).toBe('P-123456');
  });

  it('accepts a legacy manual code, upper-cased', () => {
    const parsed = createDealerSchema.parse({ name: 'Rahman Optics', code: 'dl-042' });
    expect(parsed.code).toBe('DL-042');
  });

  it('refuses a manual code in the generated shape', () => {
    // It would sit in the way of a future generated code and fail that insert months later.
    const result = createDealerSchema.safeParse({ name: 'Rahman Optics', code: 'p-00007' });
    expect(result.success).toBe(false);
  });

  it('refuses two default billing addresses, naming the second', () => {
    const result = createDealerSchema.safeParse({
      name: 'Rahman Optics',
      addresses: [
        { label: 'Shop', line1: 'Road 1', isDefaultBilling: true },
        { label: 'Godown', line1: 'Road 2', isDefaultBilling: true },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['addresses', 1, 'isDefaultBilling']);
  });

  it('refuses supplier terms through the dealer schema', () => {
    const result = createDealerSchema.safeParse({ name: 'X', supplier: { leadTimeDays: 3 } });
    expect(result.success).toBe(false);
  });
});
