/**
 * Variant axes and the deterministic key built from them.
 *
 * A variant is one orderable combination of a product's axes — a frame in black at 52mm, a lens
 * at −2.00/−1.25×180. `variantKey` is its canonical identity: **the same axes always produce
 * the same string**, which is what makes `getOrCreateVariant` a race-safe upsert rather than a
 * find-then-insert with a window in the middle.
 *
 * Shared, and a value export, because three places must agree on it exactly:
 *
 *  - the server, when upserting a variant during a goods receipt (Day 33) or an adjustment;
 *  - the Day-7 generator, which materialises a range of them in one go;
 *  - the client, which shows the key and previews what a generate would create.
 *
 * If any of those formatted a power differently — `-2` instead of `-2.00`, say — the same lens
 * would get two variants, each with its own stock, and neither would be wrong enough to notice.
 */

import { z } from 'zod';

import { VARIANT_AXES } from './enums.js';

/** The value an axis can hold. Numeric for powers, free text for colour and size. */
export interface VariantAxisValues {
  sph?: number | null;
  cyl?: number | null;
  add?: number | null;
  axis?: number | null;
  color?: string | null;
  size?: string | null;
}

/**
 * A dioptre as it is written on a prescription: always signed, always two decimals.
 *
 * `-2` and `-2.0` and `-2.00` are the same power, so they must not be three different keys.
 * Plano is `0.00` with no sign, which is how it is written.
 */
export function formatDioptre(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
}

/** Colour and size are free text, so they are normalised before they become part of a key. */
function slugAxis(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The canonical key: `SPH-2.00_CYL-1.25_AXIS180`, `COL-BLACK_SIZE-52`.
 *
 * Axes appear in `VARIANT_AXES` order regardless of the order they were given in, and an axis
 * with no value is omitted entirely — so the key length reflects how many axes a product
 * actually varies along.
 */
export function buildVariantKey(axes: VariantAxisValues): string {
  const parts: string[] = [];

  if (axes.sph !== null && axes.sph !== undefined) parts.push(`SPH${formatDioptre(axes.sph)}`);
  if (axes.cyl !== null && axes.cyl !== undefined) parts.push(`CYL${formatDioptre(axes.cyl)}`);
  if (axes.add !== null && axes.add !== undefined) parts.push(`ADD${formatDioptre(axes.add)}`);
  if (axes.axis !== null && axes.axis !== undefined) parts.push(`AXIS${Math.round(axes.axis)}`);
  if (axes.color) parts.push(`COL-${slugAxis(axes.color)}`);
  if (axes.size) parts.push(`SIZE-${slugAxis(axes.size)}`);

  return parts.join('_');
}

/** A human label for a variant — the same information, spaced for reading. */
export function describeAxes(axes: VariantAxisValues): string {
  const parts: string[] = [];

  if (axes.sph !== null && axes.sph !== undefined) parts.push(`SPH ${formatDioptre(axes.sph)}`);
  if (axes.cyl !== null && axes.cyl !== undefined) parts.push(`CYL ${formatDioptre(axes.cyl)}`);
  if (axes.add !== null && axes.add !== undefined) parts.push(`ADD ${formatDioptre(axes.add)}`);
  if (axes.axis !== null && axes.axis !== undefined) parts.push(`× ${Math.round(axes.axis)}°`);
  if (axes.color) parts.push(axes.color);
  if (axes.size) parts.push(String(axes.size));

  return parts.join(' ');
}

/**
 * Does `value` land on one of the steps a grid declares?
 *
 * A lens range of −10..+8 in 0.25 steps does not include −2.10, and accepting it would create a
 * variant no lab will ever make. The epsilon is not optional: dioptres are decimals, and
 * `(−2.10 − −10) / 0.25` is not exactly an integer in binary floating point even when it
 * mathematically is.
 */
export function isOnStep(value: number, min: number, step: number): boolean {
  if (step <= 0) return false;
  const multiples = (value - min) / step;
  return Math.abs(multiples - Math.round(multiples)) < 1e-6;
}

export const variantAxesSchema = z
  .object({
    sph: z.number().min(-30).max(30).nullable().optional(),
    cyl: z.number().min(-15).max(15).nullable().optional(),
    add: z.number().min(0).max(6).nullable().optional(),
    /** Cylinder axis in degrees. 0 and 180 are the same meridian; both are written in practice. */
    axis: z.number().int().min(0).max(180).nullable().optional(),
    color: z.string().trim().min(1).max(40).nullable().optional(),
    size: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .strict();

/** Which axes of a value are actually set, in catalog order. */
export function axesPresent(axes: VariantAxisValues): string[] {
  return VARIANT_AXES.filter((axis) => {
    const value = axes[axis];
    return value !== null && value !== undefined && value !== '';
  });
}
