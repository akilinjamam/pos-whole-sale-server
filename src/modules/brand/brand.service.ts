import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { Product } from '../product/product.model.js';

import { Brand, slugify, toBrandPayload } from './brand.model.js';

import type { CreateBrandInput, ListBrandsQuery, UpdateBrandInput } from './brand.schema.js';
import type { BrandDoc } from './brand.model.js';
import type { BrandPayload, PageMeta } from '@shared/types.js';
import type { FilterQuery, Types } from 'mongoose';

const SORTABLE = ['name', 'slug', 'createdAt'] as const;
const SEARCHABLE = ['name', 'slug'] as const;

/**
 * Turn a duplicate slug into a 422 on the field, rather than letting the unique index surface
 * as a 409 with a Mongo error string the form cannot attach to an input.
 */
async function assertSlugFree(
  orgId: Types.ObjectId,
  slug: string,
  exceptId?: Types.ObjectId,
): Promise<void> {
  const clash = await Brand.findOne({
    orgId,
    slug,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select('name')
    .lean();

  if (clash) {
    throw ApiError.validation('Validation failed', [
      { path: 'name', message: `"${clash.name}" already uses this name` },
    ]);
  }
}

export async function listBrands(
  orgId: Types.ObjectId,
  query: ListBrandsQuery,
): Promise<{ items: BrandPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<BrandDoc> = { orgId };
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<BrandDoc>(Brand, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { name: 1 },
  });

  // One grouped count for the page rather than one per row — the same N+1 the roles list avoids.
  const counts = await Product.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { orgId, brandId: { $in: items.map((b) => b._id) } } },
    { $group: { _id: '$brandId', count: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.count]));

  return {
    items: items.map((b) => toBrandPayload(b, countBy.get(String(b._id)) ?? 0)),
    meta,
  };
}

export async function getBrand(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<BrandPayload> {
  const brand = await Brand.findOne({ _id: id, orgId }).lean();
  if (!brand) throw ApiError.notFound('Brand');

  const productCount = await Product.countDocuments({ orgId, brandId: id });
  return toBrandPayload(brand, productCount);
}

export async function createBrand(
  orgId: Types.ObjectId,
  input: CreateBrandInput,
  actorId: Types.ObjectId,
): Promise<BrandPayload> {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) {
    throw ApiError.validation('Validation failed', [
      { path: 'name', message: 'Needs at least one letter or digit' },
    ]);
  }

  await assertSlugFree(orgId, slug);

  const brand = await Brand.create({
    ...input,
    slug,
    orgId,
    createdBy: actorId,
    updatedBy: actorId,
  });

  return toBrandPayload(brand.toObject(), 0);
}

export async function updateBrand(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateBrandInput,
  actorId: Types.ObjectId,
): Promise<BrandPayload> {
  // A rename re-derives the slug only when the caller did not pin one, so an established slug
  // that products and reports already group by is not silently rewritten by a typo fix.
  const slug = input.slug ?? (input.name ? slugify(input.name) : undefined);
  if (slug) await assertSlugFree(orgId, slug, id);

  const brand = await Brand.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { ...input, ...(slug ? { slug } : {}), updatedBy: actorId } },
    { new: true, runValidators: true },
  ).lean();

  if (!brand) throw ApiError.notFound('Brand');

  const productCount = await Product.countDocuments({ orgId, brandId: id });
  return toBrandPayload(brand, productCount);
}

/**
 * Deletion is refused while products still carry the brand.
 *
 * `brandId` is a plain reference with no cascade, so deleting anyway would leave products
 * pointing at nothing — and the symptom is a blank column on a list, months later, with no way
 * to tell what the brand was. Deactivating hides it from pickers and keeps history readable.
 */
export async function deleteBrand(orgId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
  const brand = await Brand.findOne({ _id: id, orgId }).lean();
  if (!brand) throw ApiError.notFound('Brand');

  const productCount = await Product.countDocuments({ orgId, brandId: id });
  if (productCount > 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `${productCount} product(s) still carry "${brand.name}". Deactivate it instead.`,
      { productCount },
    );
  }

  await Brand.deleteOne({ _id: id, orgId });
}
