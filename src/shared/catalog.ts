/**
 * Product attributes — the type-specific half of the catalog, as one zod discriminated union.
 *
 * **Shared, and a value export**, because both sides genuinely need the same object. The server
 * validates request bodies with it; the client's product form (Day 6) drives its attribute
 * section from it through `@hookform/resolvers/zod`, so the fields on screen, the fields the
 * API accepts, and the TypeScript type are one declaration rather than three that drift.
 *
 * Why a union on one `attrs` subdocument rather than five collections, or five nullable column
 * groups on `Product`:
 *
 *  - Five near-identical collections means every join, report and stock query is written five
 *    times, and a frame and a lens stop being comparable rows.
 *  - One flat schema with every field nullable cannot express "a lens has a power grid and a
 *    machine has a warranty" — nothing stops a frame being saved with a `serviceIntervalMonths`,
 *    and no reader can tell which fields are meaningful for which type.
 *
 * `z.discriminatedUnion` gives the third option: one subdocument, strictly validated per type,
 * and — because the discriminant is `type` — correctly narrowed in TypeScript. Reading
 * `product.attrs.grid` after checking `product.type === 'LENS'` compiles; reading it without
 * that check does not.
 *
 * There are **five product types but four attribute shapes**: frames and sunglasses are the same
 * article with different lenses in them, and the trade treats them as one catalogue with a flag.
 */

import { z } from 'zod';

import {
  FRAME_MATERIALS,
  FRAME_SHAPES,
  GENDERS,
  LENS_COATINGS,
  LENS_DESIGNS,
  LENS_MATERIALS,
  LENS_SOLD_AS,
  RIM_TYPES,
} from './enums.js';

/** Trimmed, length-capped free text that treats '' as "not given". */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()
    .default(null);

const positiveInt = (max: number) => z.number().int().min(0).max(max);

// ─── Frames and sunglasses ──────────────────────────────────────────────────────────────

/**
 * The three numbers moulded into every frame's temple arm — eye, bridge and temple in
 * millimetres. Kept as a subdocument rather than the "52-18-140" string they are printed as,
 * because the Day-6 filters and any future fitting logic need to compare them numerically.
 */
const frameSize = z
  .object({
    eye: positiveInt(90).nullable().optional().default(null),
    bridge: positiveInt(40).nullable().optional().default(null),
    temple: positiveInt(200).nullable().optional().default(null),
  })
  .strict()
  .nullable()
  .optional()
  .default(null);

const frameAttrs = z
  .object({
    modelNo: text(60),
    color: text(40),
    colorCode: text(20),
    size: frameSize,
    material: z.enum(FRAME_MATERIALS).nullable().optional().default(null),
    shape: z.enum(FRAME_SHAPES).nullable().optional().default(null),
    gender: z.enum(GENDERS).nullable().optional().default(null),
    rimType: z.enum(RIM_TYPES).nullable().optional().default(null),
    lensColor: text(40),
    polarized: z.boolean().default(false),
    uvProtection: z.boolean().default(false),
    hasCase: z.boolean().default(false),
  })
  .strict();

// ─── Lenses ─────────────────────────────────────────────────────────────────────────────

/**
 * The legal power range for this lens SKU — **not** a list of variants.
 *
 * A single SV lens spanning sph −10..+8 and cyl 0..−4 is around 600 combinations; materialising
 * those for forty lens products would put 24,000 dead documents in front of every catalogue
 * query. So the grid declares what is *orderable*, the Day-7 picker renders it, and a `Variant`
 * is created only when one is actually received or sold.
 *
 * Dioptres come in quarter steps, so the values are decimals rather than minor units — they are
 * measurements, not money, and `0.25` is exact in binary floating point.
 */
const gridBound = (min: number, max: number) =>
  z
    .number({
      // The form sends `null` for an empty box, which zod reports as "Expected number,
      // received null" — a developer's message on a user's screen. A grid is all-or-nothing
      // (see `isBlankGrid`), so an empty box here genuinely means this field is required.
      invalid_type_error: 'Required',
      required_error: 'Required',
    })
    .min(min)
    .max(max);

const lensGrid = z
  .object({
    sphMin: gridBound(-30, 30),
    sphMax: gridBound(-30, 30),
    cylMin: gridBound(-15, 15),
    cylMax: gridBound(-15, 15),
    addMin: z.number().min(0).max(6).nullable().optional().default(null),
    addMax: z.number().min(0).max(6).nullable().optional().default(null),
    /** Dioptre increment. 0.25 in practice; 0.125 exists for some progressives. */
    step: gridBound(0, 1).positive(),
  })
  .strict()
  .superRefine((grid, ctx) => {
    // Each bound is checked on the field the user would have to correct, so the message lands
    // on the right input rather than on the group.
    if (grid.sphMin > grid.sphMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sphMax'],
        message: 'Maximum sphere must not be below the minimum',
      });
    }
    if (grid.cylMin > grid.cylMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cylMax'],
        message: 'Maximum cylinder must not be below the minimum',
      });
    }
    const hasAdd = grid.addMin !== null && grid.addMax !== null;
    if (hasAdd && (grid.addMin as number) > (grid.addMax as number)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['addMax'],
        message: 'Maximum addition must not be below the minimum',
      });
    }
    // One bound without the other cannot be turned into a range, and would silently drop out
    // of the Day-7 generator rather than erroring there.
    if ((grid.addMin === null) !== (grid.addMax === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [grid.addMin === null ? 'addMin' : 'addMax'],
        message: 'Give both addition bounds, or neither',
      });
    }
  });

const lensAttrs = z
  .object({
    material: z.enum(LENS_MATERIALS),
    /** 1.56, 1.61, 1.67, 1.74 — thinner as the number rises. */
    refractiveIndex: z.number().min(1.4).max(2).nullable().optional().default(null),
    design: z.enum(LENS_DESIGNS),
    coating: z.enum(LENS_COATINGS).nullable().optional().default(null),
    photochromic: z.boolean().default(false),
    tint: text(40),
    /** Blank diameter in millimetres. */
    diameter: positiveInt(90).nullable().optional().default(null),
    soldAs: z.enum(LENS_SOLD_AS).default('PAIR'),
    grid: lensGrid.nullable().optional().default(null),
  })
  .strict();

// ─── Accessories and solutions ──────────────────────────────────────────────────────────

const accessoryAttrs = z
  .object({
    volumeMl: positiveInt(10_000).nullable().optional().default(null),
    /**
     * Drives `trackingMode: 'LOT'` — see the cross-field rule in `product.schema.ts`. Expiry is
     * a property of a batch, so it cannot be tracked on a product that does not record batches.
     */
    requiresExpiry: z.boolean().default(false),
    shelfLifeDays: positiveInt(3650).nullable().optional().default(null),
    /** Units inside one sellable pack, e.g. 6 cloths in a bag. Not a UoM — see `packs[]`. */
    packSize: positiveInt(1000).nullable().optional().default(null),
  })
  .strict();

// ─── Machines and equipment ─────────────────────────────────────────────────────────────

const machineAttrs = z
  .object({
    modelNo: text(60),
    manufacturer: text(80),
    countryOfOrigin: text(60),
    warrantyMonths: positiveInt(120).nullable().optional().default(null),
    powerSpec: text(80),
    dimensions: text(80),
    installationRequired: z.boolean().default(false),
    serviceIntervalMonths: positiveInt(120).nullable().optional().default(null),
  })
  .strict();

// ─── The union ──────────────────────────────────────────────────────────────────────────

/**
 * Attributes by product type.
 *
 * The discriminant is `type`, duplicated inside `attrs` so the union can narrow on it. The
 * product schema asserts that this copy matches the product's own `type` — see
 * `product.schema.ts` — so the duplication cannot drift.
 */
export const productAttrsSchema = z
  .discriminatedUnion('type', [
    frameAttrs.extend({ type: z.literal('FRAME') }),
    frameAttrs.extend({ type: z.literal('SUNGLASS') }),
    lensAttrs.extend({ type: z.literal('LENS') }),
    accessoryAttrs.extend({ type: z.literal('ACCESSORY') }),
    machineAttrs.extend({ type: z.literal('MACHINE') }),
  ])
  /**
   * Cross-field rules, applied to the union rather than to its members.
   *
   * `.superRefine()` returns a `ZodEffects`, and `z.discriminatedUnion` accepts only plain
   * `ZodObject`s — so a member that refines itself cannot be a member. Hanging the rules here
   * keeps the discriminated narrowing (and its precise "unrecognised type" errors) and puts
   * every per-type rule in one readable switch.
   */
  .superRefine((attrs, ctx) => {
    if (attrs.type === 'LENS') {
      // A progressive or bifocal is defined by its reading addition; a grid without one cannot
      // describe the product, and the Day-7 generator would produce distance-only variants.
      const needsAdd = attrs.design === 'PROGRESSIVE' || attrs.design === 'BIFOCAL';
      if (needsAdd && attrs.grid && attrs.grid.addMin === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['grid', 'addMin'],
          message: `A ${attrs.design.toLowerCase()} lens needs an addition range`,
        });
      }
    }

    if (attrs.type === 'ACCESSORY' && attrs.requiresExpiry && attrs.shelfLifeDays === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shelfLifeDays'],
        message: 'Give a shelf life, so an expiry date can be computed at goods receipt',
      });
    }
  });

export type ProductAttrs = z.infer<typeof productAttrsSchema>;

/** Narrowed helpers, for code that has already established the type. */
export type FrameAttrs = Extract<ProductAttrs, { type: 'FRAME' | 'SUNGLASS' }>;
export type LensAttrs = Extract<ProductAttrs, { type: 'LENS' }>;
export type AccessoryAttrs = Extract<ProductAttrs, { type: 'ACCESSORY' }>;
export type MachineAttrs = Extract<ProductAttrs, { type: 'MACHINE' }>;

export type LensGrid = NonNullable<LensAttrs['grid']>;

/**
 * The axes a product of this type may vary along.
 *
 * Used by the product form to offer the right boxes, and by the Day-7 variant generator to
 * reject an axis that makes no sense for the type — a cylinder on a machine, say.
 */
export const AXES_BY_TYPE = {
  FRAME: ['color', 'size'],
  SUNGLASS: ['color', 'size'],
  LENS: ['sph', 'cyl', 'axis', 'add'],
  ACCESSORY: ['color', 'size'],
  MACHINE: [],
} as const;

/**
 * Is this a power grid the user has not actually filled in?
 *
 * A form binds every grid input to a key, so clearing them all leaves an object of nulls rather
 * than the absent grid the schema expects — and the lens then fails validation on fields the
 * user has deliberately emptied, with no way back to "this lens has no range". Treating an
 * all-blank grid as no grid is what makes the section optional in practice as well as in the
 * type.
 *
 * Shared, because the form must decide this the same way the API does: if they disagreed, a
 * lens would save from one and be rejected by the other.
 */
export function isBlankGrid(grid: unknown): boolean {
  if (!grid || typeof grid !== 'object') return true;
  return Object.values(grid as Record<string, unknown>).every(
    (v) => v === null || v === undefined || v === '',
  );
}

/** Replace an all-blank grid with `null`, leaving everything else untouched. */
export function normaliseAttrs<T extends Record<string, unknown>>(attrs: T): T {
  if ('grid' in attrs && isBlankGrid(attrs.grid)) {
    return { ...attrs, grid: null };
  }
  return attrs;
}

/**
 * Every dioptre step a grid declares, inclusive of both bounds.
 *
 * Shared because it is the single definition of "what this lens is orderable in": the Day-7
 * generator materialises variants from it, and the form's power picker offers the same values.
 * Two implementations would mean a picker offering a power the API rejects.
 *
 * Steps are accumulated by multiplication rather than repeated addition — `0.1 + 0.2` is the
 * classic float example, and summing 0.25 eighty times drifts far enough to miss a bound.
 */
export function gridSteps(min: number, max: number, step: number): number[] {
  if (step <= 0 || max < min) return [];

  const count = Math.floor((max - min) / step + 1e-9);
  const values: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    values.push(Math.round((min + i * step) * 1000) / 1000);
  }
  return values;
}
