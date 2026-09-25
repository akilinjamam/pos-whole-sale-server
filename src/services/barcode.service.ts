import { ApiError } from '../lib/ApiError.js';
import { Product, toProductPayload } from '../modules/product/product.model.js';
import { Variant, toVariantPayload } from '../modules/variant/variant.model.js';
import { describeAxes } from '../shared/variant.js';

import type { ProductDoc } from '../modules/product/product.model.js';
import type { BarcodeMatch } from '@shared/types.js';
import type { Types } from 'mongoose';
import type { ApiFieldError } from '@shared/types.js';

/**
 * Barcodes, across every place one can live.
 *
 * A scanned code has to resolve to exactly one thing, and in this system it could be attached
 * to three:
 *
 *  - the **product** itself — one piece of that item;
 *  - a **pack** on the product — a scan of a carton label means 144 pieces, not 1;
 *  - a **variant** — the specific colour, size or power.
 *
 * So uniqueness cannot be a per-collection index. `Product.barcode` and `Variant.barcode` each
 * carry one, but nothing stops a carton barcode colliding with a variant's, and the scanner
 * would then resolve the same code two ways depending on which query ran first. This service is
 * the single place that owns the namespace: every write goes through `assertBarcodeFree`, and
 * every scan through `findByBarcode`.
 *
 * Lives in `services/` rather than a module because it reads across three collections — the
 * same reason `identity.service.ts` does.
 */

/**
 * Is this code already taken anywhere in the org?
 *
 * `except` names what is allowed to already hold it — the document currently being saved, which
 * would otherwise collide with itself on every update.
 */
export async function assertBarcodeFree(
  orgId: Types.ObjectId,
  code: string,
  except: { productId?: Types.ObjectId; variantId?: Types.ObjectId } = {},
  path = 'barcode',
): Promise<void> {
  const notProduct = except.productId ? { _id: { $ne: except.productId } } : {};
  const notVariant = except.variantId ? { _id: { $ne: except.variantId } } : {};

  const [onProduct, onPack, onVariant] = await Promise.all([
    Product.findOne({ orgId, barcode: code, ...notProduct })
      .select('name sku')
      .lean(),
    Product.findOne({ orgId, 'packs.barcode': code, ...notProduct })
      .select('name sku packs')
      .lean(),
    Variant.findOne({ orgId, barcode: code, ...notVariant })
      .select('sku')
      .lean(),
  ]);

  if (onProduct) {
    throw ApiError.validation('Validation failed', [
      { path, message: `Already used by "${onProduct.name}" (${onProduct.sku})` },
    ]);
  }

  if (onPack) {
    const pack = onPack.packs.find((p) => p.barcode === code);
    throw ApiError.validation('Validation failed', [
      {
        path,
        message: `Already used by the ${pack?.code ?? 'pack'} of "${onPack.name}"`,
      },
    ]);
  }

  if (onVariant) {
    throw ApiError.validation('Validation failed', [
      { path, message: `Already used by variant ${onVariant.sku}` },
    ]);
  }
}

/**
 * Check every barcode a product carries in one save — its own and its packs'.
 *
 * Duplicates *within* the submitted packs are caught here too. The database cannot: the packs
 * are one subdocument array on one document, so two identical barcodes inside it violate no
 * index, and the product would save with a carton and an inner pack that scan identically.
 */
export async function assertProductBarcodesFree(
  orgId: Types.ObjectId,
  product: { barcode?: string | null; packs?: { code: string; barcode?: string | null }[] },
  exceptProductId?: Types.ObjectId,
): Promise<void> {
  const fields: ApiFieldError[] = [];
  const seen = new Map<string, string>();

  if (product.barcode) seen.set(product.barcode, 'barcode');

  (product.packs ?? []).forEach((pack, index) => {
    if (!pack.barcode) return;
    const already = seen.get(pack.barcode);
    if (already) {
      fields.push({
        path: `packs.${index}.barcode`,
        message:
          already === 'barcode'
            ? 'Same as the product barcode — a scan could not tell them apart'
            : `Same as another pack's barcode`,
      });
    }
    seen.set(pack.barcode, `packs.${index}.barcode`);
  });

  if (fields.length > 0) throw ApiError.validation('Validation failed', fields);

  // Then against the rest of the org, one code at a time so the error names the right input.
  for (const [code, path] of seen) {
    await assertBarcodeFree(orgId, code, { productId: exceptProductId }, path);
  }
}

/**
 * Resolve a scanned code to something sellable.
 *
 * Returns the quantity the scan *means* as well as what it identifies: scanning a carton label
 * adds 144 pieces to a cart, not 1. The POS counter (Day 19) and the dispatch packing screen
 * (Day 25) both read this, and neither should be re-deriving a pack factor from the product.
 *
 * Order matters only for a namespace that has been corrupted by data predating
 * `assertBarcodeFree`; for a clean org at most one of the three can match.
 */
export async function findByBarcode(
  orgId: Types.ObjectId,
  code: string,
  includeCost: boolean,
): Promise<BarcodeMatch | null> {
  const variant = await Variant.findOne({ orgId, barcode: code }).lean();
  if (variant) {
    const product = await Product.findOne({ _id: variant.productId, orgId }).lean();
    if (product) {
      return {
        product: toProductPayload(product, { includeCost }),
        variant: toVariantPayload(variant, describeAxes(variant.axes)),
        uomCode: product.baseUom,
        qtyBase: 1,
        matchedOn: 'VARIANT',
      };
    }
  }

  const onProduct = await Product.findOne({ orgId, barcode: code }).lean();
  if (onProduct) {
    return {
      product: toProductPayload(onProduct, { includeCost }),
      variant: null,
      uomCode: onProduct.baseUom,
      qtyBase: 1,
      matchedOn: 'PRODUCT',
    };
  }

  const onPack = await Product.findOne({ orgId, 'packs.barcode': code }).lean();
  if (onPack) {
    const pack = onPack.packs.find((p) => p.barcode === code);
    if (pack) {
      return {
        product: toProductPayload(onPack, { includeCost }),
        variant: null,
        uomCode: pack.code,
        // The whole point of a pack barcode: one scan is `factor` base units.
        qtyBase: pack.factor,
        matchedOn: 'PACK',
      };
    }
  }

  return null;
}

/** Barcodes already in use by a product, for the print sheet to render. */
export function barcodesOf(product: ProductDoc): { code: string; label: string }[] {
  const codes: { code: string; label: string }[] = [];
  if (product.barcode) codes.push({ code: product.barcode, label: product.baseUom });
  for (const pack of product.packs) {
    if (pack.barcode) codes.push({ code: pack.barcode, label: pack.code });
  }
  return codes;
}
