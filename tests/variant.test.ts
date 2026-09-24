import { describe, expect, it } from 'vitest';

import { gridSteps } from '../src/shared/catalog.js';
import {
  axesPresent,
  buildVariantKey,
  describeAxes,
  formatDioptre,
  isOnStep,
} from '../src/shared/variant.js';

/**
 * The functions that decide a variant's identity.
 *
 * They are tested harder than their size suggests because the failure they guard against is
 * invisible: if the server and the client ever format the same power differently, the same lens
 * gets two variants, each holding part of its stock, and nothing errors. The ledger simply
 * reconciles to neither, weeks later.
 */

describe('formatDioptre', () => {
  it('always signs and always shows two decimals', () => {
    expect(formatDioptre(-2)).toBe('-2.00');
    expect(formatDioptre(2)).toBe('+2.00');
    expect(formatDioptre(-1.25)).toBe('-1.25');
    expect(formatDioptre(0.5)).toBe('+0.50');
  });

  it('writes plano unsigned', () => {
    expect(formatDioptre(0)).toBe('0.00');
    expect(formatDioptre(-0)).toBe('0.00');
  });

  it('collapses equal powers written differently', () => {
    // The whole point: these are one power, so they must be one key.
    expect(formatDioptre(-2)).toBe(formatDioptre(-2.0));
    expect(formatDioptre(-2.0)).toBe(formatDioptre(-2.004));
  });
});

describe('buildVariantKey', () => {
  it('matches the documented shape', () => {
    expect(buildVariantKey({ sph: -2, cyl: -1.25, axis: 0 })).toBe('SPH-2.00_CYL-1.25_AXIS0');
  });

  it('is independent of the order the axes are given in', () => {
    const a = buildVariantKey({ sph: -2, cyl: -1.25, axis: 180 });
    const b = buildVariantKey({ axis: 180, cyl: -1.25, sph: -2 });
    expect(a).toBe(b);
  });

  it('omits axes that are absent, null or empty', () => {
    expect(buildVariantKey({ sph: -2 })).toBe('SPH-2.00');
    expect(buildVariantKey({ sph: -2, cyl: null, color: null })).toBe('SPH-2.00');
    expect(buildVariantKey({ color: 'Black' })).toBe('COL-BLACK');
  });

  it('keeps plano, which is a real power and not "no value"', () => {
    expect(buildVariantKey({ sph: 0, cyl: 0 })).toBe('SPH0.00_CYL0.00');
  });

  it('normalises colour and size so spelling variations do not fork a variant', () => {
    const a = buildVariantKey({ color: 'Matte Black', size: '52' });
    const b = buildVariantKey({ color: 'matte  black', size: '52' });
    expect(a).toBe(b);
    expect(a).toBe('COL-MATTE-BLACK_SIZE-52');
  });
});

describe('describeAxes', () => {
  it('reads as a prescription', () => {
    expect(describeAxes({ sph: -2, cyl: -1.25, axis: 180 })).toBe('SPH -2.00 CYL -1.25 × 180°');
  });
});

describe('axesPresent', () => {
  it('reports set axes in catalog order, whatever order they arrived in', () => {
    expect(axesPresent({ size: 'L', sph: -1, color: 'Black' })).toEqual(['sph', 'color', 'size']);
  });

  it('treats null, undefined and empty string as absent', () => {
    expect(axesPresent({ sph: null, cyl: undefined, color: '' })).toEqual([]);
  });
});

describe('isOnStep', () => {
  it('accepts values on the grid', () => {
    expect(isOnStep(-2, -6, 0.25)).toBe(true);
    expect(isOnStep(-1.75, -6, 0.25)).toBe(true);
    expect(isOnStep(-6, -6, 0.25)).toBe(true);
  });

  it('rejects values between steps', () => {
    expect(isOnStep(-1.1, -6, 0.25)).toBe(false);
    expect(isOnStep(-2.3, -6, 0.25)).toBe(false);
  });

  it('survives floating-point accumulation across a long range', () => {
    // (0.25 added 80 times) drifts far enough from 14 to fail an exact comparison.
    expect(isOnStep(14, -6, 0.25)).toBe(true);
    expect(isOnStep(2.75, -10, 0.25)).toBe(true);
  });
});

describe('gridSteps', () => {
  it('includes both bounds', () => {
    expect(gridSteps(-1, 1, 0.5)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  it('counts a real lens range correctly', () => {
    // −10..+8 at 0.25 is 73 powers, inclusive of both ends.
    expect(gridSteps(-10, 8, 0.25)).toHaveLength(73);
  });

  it('does not drop the last step to floating-point drift', () => {
    const steps = gridSteps(-6, 6, 0.25);
    expect(steps[steps.length - 1]).toBe(6);
    expect(steps).toHaveLength(49);
  });

  it('returns nothing for a reversed or zero-step range', () => {
    expect(gridSteps(1, -1, 0.25)).toEqual([]);
    expect(gridSteps(-1, 1, 0)).toEqual([]);
  });
});
