import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { gridSteps } from '../../shared/catalog.js';
import { axesPresent, buildVariantKey, describeAxes, isOnStep } from '../../shared/variant.js';
import { assertBarcodeFree } from '../../services/barcode.service.js';
import { Product } from '../product/product.model.js';

import { Variant, toVariantPayload } from './variant.model.js';

import type {
  CreateVariantInput,
  GenerateVariantsInput,
  ListVariantsQuery,
  UpdateVariantInput,
} from './variant.schema.js';
import type { VariantDoc } from './variant.model.js';
import type { LensGrid } from '@shared/catalog.js';
import type { PageMeta, VariantPayload } from '@shared/types.js';
import type { VariantAxisValues } from '@shared/variant.js';
import type { ProductDoc } from '../product/product.model.js';
import type { ClientSession, FilterQuery } from 'mongoose';

const SORTABLE = ['sku', 'variantKey', 'createdAt'] as const;
const SEARCHABLE = ['sku', 'variantKey', 'barcode'] as const;

/**
 * A hard ceiling on one generate call.
 *
 * A full sph −10..+8 × cyl −4..0 grid at 0.25 steps is 73 × 17 = 1,241 variants, which is a
 * legitimate stock range. Crossing that with 181 axes is 224,621, which is not — it is a
 * mistyped form, and materialising it would take the catalogue screen down with it.
 */
const MAX_GENERATED = 2_000;

async function loadProduct(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
): Promise<ProductDoc> {
  const product = await Product.findOne({ _id: productId, orgId }).lean();
  if (!product) throw ApiError.notFound('Product');
  return product;
}

function assertHasVariants(product: ProductDoc): void {
  if (!product.hasVariants || product.variantAxes.length === 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${product.name}" does not have variants. Turn them on and choose its axes first.`,
    );
  }
}

/** The declared power grid, or null for a lens that is held at a single fixed power. */
function gridOf(product: ProductDoc): LensGrid | null {
  if (product.attrs.type !== 'LENS') return null;
  return product.attrs.grid ?? null;
}

/**
 * Check one set of axes against what the product declares.
 *
 * Two separate rules, and both matter:
 *
 *  - **Every declared axis must be present, and nothing else.** A product that varies by colour
 *    *and* size must not acquire a variant that names only a colour: its key would be shorter,
 *    so it would not collide with the full one, and the same frame would end up as two variants.
 *  - **Powers must sit inside the declared grid, on one of its steps.** This is the Day-7
 *    requirement — a range is declared once, and generating outside it is refused rather than
 *    quietly creating a lens no lab will make.
 */
function assertAxesValid(product: ProductDoc, axes: VariantAxisValues, path = 'axes'): void {
  const declared = [...product.variantAxes].sort();
  const given = axesPresent(axes).sort();

  if (declared.join(',') !== given.join(',')) {
    throw ApiError.validation('Validation failed', [
      {
        path,
        message: `This product varies by ${declared.join(' and ')} — give exactly those${
          given.length > 0 ? `, not ${given.join(' and ')}` : ''
        }`,
      },
    ]);
  }

  const grid = gridOf(product);
  if (!grid) return;

  const bounds: [keyof VariantAxisValues, number, number][] = [
    ['sph', grid.sphMin, grid.sphMax],
    ['cyl', grid.cylMin, grid.cylMax],
  ];
  if (grid.addMin !== null && grid.addMax !== null) {
    bounds.push(['add', grid.addMin, grid.addMax]);
  }

  for (const [axis, min, max] of bounds) {
    const value = axes[axis];
    if (typeof value !== 'number') continue;

    if (value < min || value > max) {
      throw ApiError.validation('Validation failed', [
        {
          path: `${path}.${axis}`,
          message: `Outside the declared range (${min} to ${max})`,
        },
      ]);
    }

    if (!isOnStep(value, min, grid.step)) {
      throw ApiError.validation('Validation failed', [
        {
          path: `${path}.${axis}`,
          message: `Not on a ${grid.step} step from ${min}`,
        },
      ]);
    }
  }

  // An addition on a lens whose grid declares none has nowhere legal to sit.
  if (typeof axes.add === 'number' && (grid.addMin === null || grid.addMax === null)) {
    throw ApiError.validation('Validation failed', [
      { path: `${path}.add`, message: 'This lens declares no addition range' },
    ]);
  }
}

/** `FRM-0001` + `COL-BLACK_SIZE-52` → `FRM-0001-COL-BLACK_SIZE-52`, deterministic and unique. */
function deriveSku(product: ProductDoc, variantKey: string): string {
  return `${product.sku}-${variantKey}`.toUpperCase().slice(0, 80);
}

export async function listVariants(
  orgId: Types.ObjectId,
  query: ListVariantsQuery,
): Promise<{ items: VariantPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<VariantDoc> = {
    orgId,
    productId: new Types.ObjectId(query.productId),
  };
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<VariantDoc>(Variant, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { variantKey: 1 },
  });

  return { items: items.map((v) => toVariantPayload(v, describeAxes(v.axes))), meta };
}

/**
 * Find the variant for these axes, creating it if it does not exist yet.
 *
 * **This is the function the rest of the system calls.** Goods receipt (Day 33), stock
 * adjustments (Day 14) and counts all reach a point where they know a product and a set of
 * axes and need the variant id to post against — and the variant may legitimately not exist,
 * because variants are materialised on first use.
 *
 * It is a single `findOneAndUpdate` with `upsert: true`, not a find followed by an insert. Two
 * receipts of the same power arriving together both aim at the same unique index entry: one
 * inserts, the other reads it back. The find-then-insert version has a window between the two
 * statements in which both see nothing, and both insert — after which the product has two
 * variants for one lens, each holding part of the stock, and the ledger reconciles to neither.
 *
 * Takes a `session` so it joins the caller's transaction rather than committing on its own.
 */
export async function getOrCreateVariant(
  orgId: Types.ObjectId,
  productId: Types.ObjectId,
  axes: VariantAxisValues,
  session?: ClientSession,
  actorId?: Types.ObjectId,
): Promise<VariantDoc> {
  const product = await loadProduct(orgId, productId);
  assertHasVariants(product);
  assertAxesValid(product, axes);

  const variantKey = buildVariantKey(axes);

  const variant = await Variant.findOneAndUpdate(
    { orgId, productId, variantKey },
    {
      // Only on insert: an existing variant's barcode, price delta and active flag are the
      // user's, and a receipt must not reset them.
      $setOnInsert: {
        orgId,
        productId,
        variantKey,
        axes,
        sku: deriveSku(product, variantKey),
        barcode: null,
        priceDeltaMinor: 0,
        isActive: true,
        createdBy: actorId ?? null,
        updatedBy: actorId ?? null,
      },
    },
    { new: true, upsert: true, session },
  ).lean();

  // `upsert` with `new: true` always returns a document; the guard is for the type, not reality.
  if (!variant) throw ApiError.internal('Failed to resolve variant');
  return variant;
}

export async function createVariant(
  orgId: Types.ObjectId,
  input: CreateVariantInput,
  actorId: Types.ObjectId,
): Promise<VariantPayload> {
  const productId = new Types.ObjectId(input.productId);
  const product = await loadProduct(orgId, productId);
  assertHasVariants(product);
  assertAxesValid(product, input.axes);

  const variantKey = buildVariantKey(input.axes);

  const existing = await Variant.findOne({ orgId, productId, variantKey }).select('sku').lean();
  if (existing) {
    throw ApiError.validation('Validation failed', [
      { path: 'axes', message: `Already exists as ${existing.sku}` },
    ]);
  }

  if (input.barcode) await assertBarcodeFree(orgId, input.barcode);

  const variant = await Variant.create({
    orgId,
    productId,
    variantKey,
    axes: input.axes,
    sku: input.sku ?? deriveSku(product, variantKey),
    barcode: input.barcode ?? null,
    priceDeltaMinor: input.priceDeltaMinor ?? 0,
    isActive: input.isActive ?? true,
    createdBy: actorId,
    updatedBy: actorId,
  });

  const plain = variant.toObject();
  return toVariantPayload(plain, describeAxes(plain.axes));
}

export async function updateVariant(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateVariantInput,
  actorId: Types.ObjectId,
): Promise<VariantPayload> {
  if (input.barcode) await assertBarcodeFree(orgId, input.barcode, { variantId: id });

  const variant = await Variant.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { ...input, updatedBy: actorId } },
    { new: true, runValidators: true },
  ).lean();

  if (!variant) throw ApiError.notFound('Variant');
  return toVariantPayload(variant, describeAxes(variant.axes));
}

/**
 * Remove a variant outright.
 *
 * Unlike products and locations, a variant genuinely can be deleted — generating a range is one
 * click, so pruning a few hundred that were created by a mistyped bound is a normal thing to
 * want, and deactivating them would leave the list permanently cluttered.
 *
 * **This becomes conditional on Day 13.** Once `StockLedger` and `StockBalance` exist, a variant
 * that has ever been moved must be deactivated instead, or its history orphans. Today nothing
 * references a variant, so there is nothing to orphan.
 */
export async function deleteVariant(orgId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
  const result = await Variant.deleteOne({ _id: id, orgId });
  if (result.deletedCount === 0) throw ApiError.notFound('Variant');
}

export interface GenerateResult {
  /** How many the request describes in total, existing ones included. */
  requested: number;
  created: number;
  /** Already present, so left untouched — generating twice is safe. */
  skipped: number;
  dryRun: boolean;
}

/**
 * Materialise every combination in a sub-range of the product's declared grid.
 *
 * The bounds default to the product's own declaration, so "everything legal" is an empty body;
 * anything narrower is checked against it, and anything wider is refused. `dryRun` returns the
 * count without writing, which is what lets the UI say "this will create 1,241 variants" before
 * the user commits to it.
 *
 * Re-running is safe and cheap: existing keys are skipped, so widening a range later adds only
 * the new combinations.
 */
export async function generateVariants(
  orgId: Types.ObjectId,
  input: GenerateVariantsInput,
  actorId: Types.ObjectId,
): Promise<GenerateResult> {
  const productId = new Types.ObjectId(input.productId);
  const product = await loadProduct(orgId, productId);
  assertHasVariants(product);

  const declared = new Set(product.variantAxes);
  const grid = gridOf(product);

  /**
   * A bound given for an axis the product does not vary along is a mistake, not a no-op.
   *
   * Ignoring it silently is the dangerous reading: someone who passes 181 cylinder axes to a
   * lens that does not vary by axis gets a cheerful 200 and a fraction of the variants they
   * asked for, with nothing saying why.
   */
  const rejectUndeclared: [string, boolean, string][] = [
    ['sphFrom', input.sphFrom !== undefined, 'sph'],
    ['sphTo', input.sphTo !== undefined, 'sph'],
    ['cylFrom', input.cylFrom !== undefined, 'cyl'],
    ['cylTo', input.cylTo !== undefined, 'cyl'],
    ['addFrom', input.addFrom !== undefined, 'add'],
    ['addTo', input.addTo !== undefined, 'add'],
    ['axes', (input.axes?.length ?? 0) > 0, 'axis'],
    ['colors', (input.colors?.length ?? 0) > 0, 'color'],
    ['sizes', (input.sizes?.length ?? 0) > 0, 'size'],
  ];

  const stray = rejectUndeclared
    .filter(([, given, axis]) => given && !declared.has(axis as never))
    .map(([path, , axis]) => ({
      path,
      message: `"${product.name}" does not vary by ${axis}`,
    }));

  if (stray.length > 0) throw ApiError.validation('Validation failed', stray);

  /** A numeric axis's values: the requested sub-range, defaulted and bounds-checked. */
  const rangeFor = (
    axis: 'sph' | 'cyl' | 'add',
    from: number | undefined,
    to: number | undefined,
  ): (number | null)[] => {
    if (!declared.has(axis)) return [null];

    if (!grid) {
      throw ApiError.conflict(
        'VALIDATION_FAILED',
        `"${product.name}" varies by ${axis} but declares no power grid. Add one to the product first.`,
      );
    }

    const bounds =
      axis === 'sph'
        ? { min: grid.sphMin, max: grid.sphMax }
        : axis === 'cyl'
          ? { min: grid.cylMin, max: grid.cylMax }
          : { min: grid.addMin, max: grid.addMax };

    if (bounds.min === null || bounds.max === null) {
      throw ApiError.conflict(
        'VALIDATION_FAILED',
        `"${product.name}" varies by ${axis} but declares no ${axis} range.`,
      );
    }

    const lo = from ?? bounds.min;
    const hi = to ?? bounds.max;

    // The Day-7 rule, enforced here rather than trusted from the form.
    if (lo < bounds.min || hi > bounds.max) {
      throw ApiError.validation('Validation failed', [
        {
          path: lo < bounds.min ? `${axis}From` : `${axis}To`,
          message: `Outside the declared range (${bounds.min} to ${bounds.max})`,
        },
      ]);
    }
    if (lo > hi) {
      throw ApiError.validation('Validation failed', [
        { path: `${axis}To`, message: 'Must not be below the start of the range' },
      ]);
    }

    // Steps are counted from the grid's own minimum, so a sub-range starting mid-grid still
    // lands on the same values the full grid would have produced.
    return gridSteps(bounds.min, bounds.max, grid.step).filter((v) => v >= lo && v <= hi);
  };

  const sphValues = rangeFor('sph', input.sphFrom, input.sphTo);
  const cylValues = rangeFor('cyl', input.cylFrom, input.cylTo);
  const addValues = rangeFor('add', input.addFrom, input.addTo);

  const axisValues: (number | null)[] = declared.has('axis')
    ? input.axes?.length
      ? input.axes
      : [0]
    : [null];

  const listFor = (axis: 'color' | 'size', given: string[] | undefined): (string | null)[] => {
    if (!declared.has(axis)) return [null];
    if (!given || given.length === 0) {
      throw ApiError.validation('Validation failed', [
        { path: `${axis}s`, message: `Give at least one ${axis} to generate` },
      ]);
    }
    return given;
  };

  const colorValues = listFor('color', input.colors);
  const sizeValues = listFor('size', input.sizes);

  const total =
    sphValues.length *
    cylValues.length *
    addValues.length *
    axisValues.length *
    colorValues.length *
    sizeValues.length;

  if (total > MAX_GENERATED) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `That range describes ${total.toLocaleString('en-US')} variants, over the ${MAX_GENERATED.toLocaleString('en-US')} limit. Narrow it and generate in batches.`,
      { requested: total, limit: MAX_GENERATED },
    );
  }

  const combinations: VariantAxisValues[] = [];
  for (const sph of sphValues) {
    for (const cyl of cylValues) {
      for (const add of addValues) {
        for (const axis of axisValues) {
          for (const color of colorValues) {
            for (const size of sizeValues) {
              const axes: VariantAxisValues = {};
              if (sph !== null) axes.sph = sph;
              if (cyl !== null) axes.cyl = cyl;
              if (add !== null) axes.add = add;
              if (axis !== null) axes.axis = axis;
              if (color !== null) axes.color = color;
              if (size !== null) axes.size = size;
              combinations.push(axes);
            }
          }
        }
      }
    }
  }

  const existing = new Set(
    (await Variant.find({ orgId, productId }).select('variantKey').lean()).map(
      (v) => v.variantKey,
    ),
  );

  const fresh = combinations
    .map((axes) => ({ axes, variantKey: buildVariantKey(axes) }))
    .filter(({ variantKey }) => !existing.has(variantKey));

  if (input.dryRun) {
    return {
      requested: total,
      created: fresh.length,
      skipped: total - fresh.length,
      dryRun: true,
    };
  }

  if (fresh.length > 0) {
    // `ordered: false` so one unexpected duplicate — a concurrent receipt materialising the
    // same power mid-generate — does not abandon the rest of the batch.
    await Variant.insertMany(
      fresh.map(({ axes, variantKey }) => ({
        orgId,
        productId,
        variantKey,
        axes,
        sku: deriveSku(product, variantKey),
        barcode: null,
        priceDeltaMinor: input.priceDeltaMinor ?? 0,
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      })),
      { ordered: false },
    );
  }

  return {
    requested: total,
    created: fresh.length,
    skipped: total - fresh.length,
    dryRun: false,
  };
}
