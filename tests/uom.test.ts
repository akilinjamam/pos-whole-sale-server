import { describe, expect, it } from 'vitest';

import {
  UomError,
  describeQty,
  fromBase,
  isWholePacks,
  packFactor,
  splitIntoPacks,
  toBase,
  uomOptions,
  validatePacks,
} from '../src/shared/uom.js';

/**
 * The Day-8 acceptance case, and the arithmetic under it.
 *
 * "A dealer ordering 5 dozen and the system recording 5 pieces" is the bug this module exists
 * to make impossible, so the round trip is tested in both directions on the exact product the
 * work plan names: a frame in PCS with DOZ ×12 and CTN ×144.
 */
const frame = {
  baseUom: 'PCS',
  packs: [
    { code: 'DOZ', name: 'Dozen', factor: 12 },
    { code: 'CTN', name: 'Carton', factor: 144 },
  ],
};

describe('the frame from the work plan: PCS, DOZ ×12, CTN ×144', () => {
  it('converts up', () => {
    expect(toBase(5, 'DOZ', frame)).toBe(60);
    expect(toBase(1, 'CTN', frame)).toBe(144);
    expect(toBase(3, 'PCS', frame)).toBe(3);
  });

  it('converts back down', () => {
    expect(fromBase(60, 'DOZ', frame)).toBe(5);
    expect(fromBase(144, 'CTN', frame)).toBe(1);
    expect(fromBase(144, 'DOZ', frame)).toBe(12);
  });

  it('round-trips every declared unit', () => {
    for (const { code } of uomOptions(frame)) {
      for (const qty of [1, 3, 25]) {
        expect(fromBase(toBase(qty, code, frame), code, frame)).toBe(qty);
      }
    }
  });
});

describe('packFactor', () => {
  it('treats the base unit as factor 1 without it being listed', () => {
    expect(packFactor(frame, 'PCS')).toBe(1);
  });

  it('returns null for a unit the product does not declare', () => {
    expect(packFactor(frame, 'BOX')).toBeNull();
  });
});

describe('toBase', () => {
  it('rejects a fractional pack quantity', () => {
    // 1.5 dozen is 18 pieces and would convert cleanly — it is refused because it is not how
    // the trade orders, and allowing it puts non-integer qtyBase into the stock engine.
    expect(() => toBase(1.5, 'DOZ', frame)).toThrow(UomError);
    expect(() => toBase(1.5, 'DOZ', frame)).toThrow(/whole number/i);
  });

  it('rejects an undeclared unit, and says what is available', () => {
    expect(() => toBase(1, 'BOX', frame)).toThrow(/PCS, DOZ, CTN/);
  });

  it('names the failure so a caller can branch on it', () => {
    try {
      toBase(0.5, 'DOZ', frame);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as UomError).code).toBe('FRACTIONAL_PACK');
    }
  });
});

describe('fromBase', () => {
  it('may be fractional, because it is the display direction', () => {
    expect(fromBase(66, 'DOZ', frame)).toBe(5.5);
    expect(fromBase(6, 'DOZ', frame)).toBe(0.5);
  });

  it('does not leak float noise', () => {
    expect(fromBase(100, 'CTN', frame)).toBe(0.69);
  });
});

describe('isWholePacks', () => {
  it('is the guard a document posting uses', () => {
    expect(isWholePacks(60, 'DOZ', frame)).toBe(true);
    expect(isWholePacks(66, 'DOZ', frame)).toBe(false);
    expect(isWholePacks(144, 'CTN', frame)).toBe(true);
    expect(isWholePacks(0, 'DOZ', frame)).toBe(true);
  });
});

describe('splitIntoPacks', () => {
  it('uses the largest packs first', () => {
    expect(splitIntoPacks(150, frame)).toEqual([
      { code: 'CTN', qty: 1 },
      { code: 'PCS', qty: 6 },
    ]);
  });

  it('omits packs that do not fit', () => {
    expect(splitIntoPacks(24, frame)).toEqual([{ code: 'DOZ', qty: 2 }]);
  });

  it('always returns something, even for zero', () => {
    expect(splitIntoPacks(0, frame)).toEqual([{ code: 'PCS', qty: 0 }]);
  });

  it('falls back to base units for a product with no packs', () => {
    expect(splitIntoPacks(7, { baseUom: 'PCS', packs: [] })).toEqual([
      { code: 'PCS', qty: 7 },
    ]);
  });
});

describe('describeQty', () => {
  it('reads the way a storekeeper looks at a shelf', () => {
    expect(describeQty(150, frame)).toBe('1 CTN + 6 PCS');
    expect(describeQty(12, frame)).toBe('1 DOZ');
  });

  it('carries the sign once, on the whole expression', () => {
    expect(describeQty(-150, frame)).toBe('-1 CTN + 6 PCS');
  });
});

describe('validatePacks', () => {
  it('accepts the work plan’s frame', () => {
    expect(validatePacks('PCS', frame.packs)).toEqual([]);
  });

  it('rejects a duplicate code', () => {
    const problems = validatePacks('PCS', [
      { code: 'DOZ', name: 'Dozen', factor: 12 },
      { code: 'DOZ', name: 'Dz', factor: 24 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 1, field: 'code' });
  });

  it('rejects a pack that is the base unit', () => {
    const problems = validatePacks('PCS', [{ code: 'PCS', name: 'Piece', factor: 12 }]);
    expect(problems[0]).toMatchObject({ index: 0, field: 'code' });
  });

  it('rejects a factor below 2 or fractional', () => {
    expect(validatePacks('PCS', [{ code: 'DOZ', name: 'D', factor: 1 }])[0]).toMatchObject({
      field: 'factor',
    });
    expect(validatePacks('PCS', [{ code: 'DOZ', name: 'D', factor: 12.5 }])[0]).toMatchObject({
      field: 'factor',
    });
  });
});
