import { Types } from 'mongoose';

import { ApiError } from '../lib/ApiError.js';
import { toBase, UomError } from '../shared/uom.js';
import { describeAxes } from '../shared/variant.js';
import { Location } from '../modules/location/location.model.js';
import { Product } from '../modules/product/product.model.js';
import { Variant } from '../modules/variant/variant.model.js';

import type { LineNames, StockDocLineDoc } from '../modules/stock/stockDocLine.js';
import type { ApiFieldError } from '@shared/types.js';

/**
 * Turning entered lines into stock lines, once, for every stock document.
 *
 * Every rule a line must meet is checked here and reported **per field**, so the document editor
 * can put each message on the input that caused it:
 *
 *  - the product exists in this org, and a variant — when named — belongs to it;
 *  - a product with variants names one (stock is kept per variant), and one without does not;
 *  - the unit is one the product declares, and the quantity is whole packs (`toBase`);
 *  - the same item does not appear on two lines, which would make the document ambiguous;
 *  - lot- and serial-tracked products wait for Day 15, which gives them somewhere to record the
 *    lot or the serials — moving 30 machines as an anonymous number would break the warranty
 *    trail before it starts.
 */

export interface LineInput {
  productId: string;
  variantId?: string | null;
  uomCode?: string | null;
  /** Signed only where the document allows it (adjustments). */
  qty: number;
}

const itemKey = (productId: string, variantId?: string | null) =>
  `${productId}|${variantId ?? '-'}`;

export async function resolveStockLines(
  orgId: Types.ObjectId,
  lines: readonly LineInput[],
  path = 'lines',
): Promise<StockDocLineDoc[]> {
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const variantIds = [...new Set(lines.flatMap((l) => (l.variantId ? [l.variantId] : [])))];

  const [products, variants] = await Promise.all([
    Product.find({ orgId, _id: { $in: productIds } })
      .select('sku baseUom packs hasVariants trackingMode')
      .lean(),
    variantIds.length > 0
      ? Variant.find({ orgId, _id: { $in: variantIds } })
          .select('productId')
          .lean()
      : Promise.resolve([]),
  ]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), v]));

  const errors: ApiFieldError[] = [];
  const resolved: StockDocLineDoc[] = [];
  const seen = new Map<string, number>();

  lines.forEach((line, i) => {
    const at = (field: string) => `${path}.${i}.${field}`;
    const product = productBy.get(line.productId);
    if (!product) {
      errors.push({ path: at('productId'), message: 'No such product' });
      return;
    }
    if (product.trackingMode !== 'NONE') {
      errors.push({
        path: at('productId'),
        message: `${product.sku} is ${product.trackingMode.toLowerCase()}-tracked — it needs lot/serial capture (Day 15)`,
      });
      return;
    }
    if (product.hasVariants && !line.variantId) {
      errors.push({
        path: at('variantId'),
        message: `${product.sku} is stocked per variant — choose one`,
      });
      return;
    }
    if (!product.hasVariants && line.variantId) {
      errors.push({ path: at('variantId'), message: `${product.sku} has no variants` });
      return;
    }
    if (line.variantId && !variantBy.get(line.variantId)?.productId.equals(product._id)) {
      errors.push({ path: at('variantId'), message: `Not a variant of ${product.sku}` });
      return;
    }

    const key = itemKey(line.productId, line.variantId);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      errors.push({
        path: at('productId'),
        message: `Same item as line ${earlier + 1} — combine them`,
      });
      return;
    }
    seen.set(key, i);

    const uomCode = line.uomCode || product.baseUom;
    let qtyBase: number;
    try {
      // `toBase` works on magnitudes; the sign is the document's business, not the unit's.
      qtyBase =
        Math.sign(line.qty) *
        toBase(Math.abs(line.qty), uomCode, {
          baseUom: product.baseUom,
          packs: product.packs ?? [],
        });
    } catch (error) {
      if (error instanceof UomError) {
        errors.push({
          path: at(error.code === 'UNKNOWN_UOM' ? 'uomCode' : 'qty'),
          message: error.message,
        });
        return;
      }
      throw error;
    }

    resolved.push({
      productId: product._id,
      variantId: line.variantId ? new Types.ObjectId(line.variantId) : null,
      uomCode,
      qty: line.qty,
      qtyBase,
    });
  });

  if (errors.length > 0) throw ApiError.validation('Validation failed', errors);
  return resolved;
}

/**
 * A location in this org that can hold stock for this purpose. `TRANSIT` is never a place a
 * person adjusts, counts or sends *from* by choice — goods reach it only as a transfer's leg.
 */
export async function assertStockLocation(
  orgId: Types.ObjectId,
  locationId: string,
  path: string,
  { allowTransit = false } = {},
): Promise<{ _id: Types.ObjectId; code: string; name: string; type: string }> {
  const location = await Location.findOne({ _id: locationId, orgId })
    .select('code name type isActive')
    .lean();
  if (!location)
    throw ApiError.validation('Validation failed', [{ path, message: 'No such location' }]);
  if (location.type === 'TRANSIT' && !allowTransit) {
    throw ApiError.validation('Validation failed', [
      { path, message: `${location.code} is a transit location — goods only pass through it` },
    ]);
  }
  return location;
}

/** Product and variant names for document lines, in two grouped queries. */
export async function lineNames(
  orgId: Types.ObjectId,
  lines: readonly { productId: Types.ObjectId; variantId: Types.ObjectId | null }[],
): Promise<LineNames> {
  const productIds = [...new Set(lines.map((l) => String(l.productId)))];
  const variantIds = [
    ...new Set(lines.flatMap((l) => (l.variantId ? [String(l.variantId)] : []))),
  ];
  const [products, variants] = await Promise.all([
    Product.find({ orgId, _id: { $in: productIds } })
      .select('name sku baseUom')
      .lean(),
    variantIds.length > 0
      ? Variant.find({ orgId, _id: { $in: variantIds } })
          .select('axes')
          .lean()
      : Promise.resolve([]),
  ]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantBy = new Map(variants.map((v) => [String(v._id), describeAxes(v.axes)]));

  return (l) => {
    const p = productBy.get(String(l.productId));
    return {
      productName: p?.name ?? '(deleted product)',
      sku: p?.sku ?? '',
      baseUom: p?.baseUom ?? '',
      variantLabel: l.variantId ? (variantBy.get(String(l.variantId)) ?? null) : null,
    };
  };
}
