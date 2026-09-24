import mongoose, { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { Product } from '../product/product.model.js';

import { Category, toCategoryPayload } from './category.model.js';

import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './category.schema.js';
import type { CategoryDoc } from './category.model.js';
import type { CategoryPayload, PageMeta } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

const SORTABLE = ['name', 'createdAt'] as const;
const SEARCHABLE = ['name'] as const;

/**
 * Names for a set of category ids, in one query.
 *
 * Every payload carries a breadcrumb, and resolving it per row would be one lookup per
 * ancestor per category — the N+1 that makes a tree screen feel broken.
 */
async function nameIndex(
  orgId: Types.ObjectId,
  ids: readonly Types.ObjectId[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const docs = await Category.find({ orgId, _id: { $in: ids } })
    .select('name')
    .lean();

  return new Map(docs.map((d) => [String(d._id), d.name]));
}

/** Root → self, as names. An ancestor deleted out from under us shows as `?` rather than a gap. */
function breadcrumbOf(doc: CategoryDoc, names: Map<string, string>): string[] {
  return [...doc.path.map((id) => names.get(String(id)) ?? '?'), doc.name];
}

async function loadOrFail(orgId: Types.ObjectId, id: Types.ObjectId): Promise<CategoryDoc> {
  const doc = await Category.findOne({ _id: id, orgId }).lean();
  if (!doc) throw ApiError.notFound('Category');
  return doc;
}

/**
 * The ancestor chain a node would have under `parentId`, and the parent itself.
 *
 * Also the only place the parent's existence and tenancy are checked, so a category cannot be
 * parented into another org's tree by passing its id.
 */
async function resolveParent(
  orgId: Types.ObjectId,
  parentId: Types.ObjectId | null,
): Promise<{ parent: CategoryDoc | null; path: Types.ObjectId[] }> {
  if (!parentId) return { parent: null, path: [] };

  const parent = await Category.findOne({ _id: parentId, orgId }).lean();
  if (!parent) {
    throw ApiError.validation('Validation failed', [
      { path: 'parentId', message: 'That parent category does not exist' },
    ]);
  }

  return { parent, path: [...parent.path, parent._id] };
}

export async function listCategories(
  orgId: Types.ObjectId,
  query: ListCategoriesQuery,
): Promise<{ items: CategoryPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<CategoryDoc> = { orgId };

  if (query.parentId) {
    filter.parentId = query.parentId === 'root' ? null : new Types.ObjectId(query.parentId);
  }
  // Multikey hit on `path` — the whole subtree at any depth, without a recursive walk.
  if (query.under) filter.path = new Types.ObjectId(query.under);
  if (query.productType) filter.productType = query.productType;
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  const { items, meta } = await paginate<CategoryDoc>(Category, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { createdAt: 1 },
  });

  const ancestorIds = [...new Set(items.flatMap((c) => c.path.map((id) => String(id))))].map(
    (id) => new Types.ObjectId(id),
  );
  const names = await nameIndex(orgId, ancestorIds);

  const ids = items.map((c) => c._id);
  const [childCounts, productCounts] = await Promise.all([
    Category.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { orgId, parentId: { $in: ids } } },
      { $group: { _id: '$parentId', count: { $sum: 1 } } },
    ]),
    Product.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { orgId, categoryId: { $in: ids } } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]),
  ]);

  const childBy = new Map(childCounts.map((c) => [String(c._id), c.count]));
  const productBy = new Map(productCounts.map((c) => [String(c._id), c.count]));

  return {
    items: items.map((c) =>
      toCategoryPayload(c, breadcrumbOf(c, names), {
        childCount: childBy.get(String(c._id)) ?? 0,
        productCount: productBy.get(String(c._id)) ?? 0,
      }),
    ),
    meta,
  };
}

export async function getCategory(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CategoryPayload> {
  const doc = await loadOrFail(orgId, id);
  const names = await nameIndex(orgId, doc.path);

  const [childCount, productCount] = await Promise.all([
    Category.countDocuments({ orgId, parentId: id }),
    Product.countDocuments({ orgId, categoryId: id }),
  ]);

  return toCategoryPayload(doc, breadcrumbOf(doc, names), { childCount, productCount });
}

export async function createCategory(
  orgId: Types.ObjectId,
  input: CreateCategoryInput,
  actorId: Types.ObjectId,
): Promise<CategoryPayload> {
  const parentId = input.parentId ? new Types.ObjectId(input.parentId) : null;
  const { parent, path } = await resolveParent(orgId, parentId);

  // A child of a FRAME branch cannot be a LENS category: the parent's restriction is what the
  // product form relies on to offer the right categories for a type.
  if (parent?.productType && input.productType && input.productType !== parent.productType) {
    throw ApiError.validation('Validation failed', [
      {
        path: 'productType',
        message: `"${parent.name}" only holds ${parent.productType} categories`,
      },
    ]);
  }

  const doc = await Category.create({
    name: input.name,
    // Inherited when not given, so a branch does not lose its restriction one level down.
    productType: input.productType ?? parent?.productType ?? null,
    isActive: input.isActive,
    parentId,
    path,
    orgId,
    createdBy: actorId,
    updatedBy: actorId,
  });

  const names = await nameIndex(orgId, path);
  const plain = doc.toObject();
  return toCategoryPayload(plain, breadcrumbOf(plain, names), {
    childCount: 0,
    productCount: 0,
  });
}

/**
 * Update, including reparenting.
 *
 * Moving a node rewrites `path` on the node **and every descendant**. That is several writes
 * that must all land or none: a descendant left with a stale path silently disappears from its
 * new branch's subtree query, and nothing errors — so it runs in a transaction.
 *
 * Day 13 introduces `lib/withTransaction.ts`; this is the first place that needed one, and it
 * will move to the helper then.
 */
export async function updateCategory(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateCategoryInput,
  actorId: Types.ObjectId,
): Promise<CategoryPayload> {
  const current = await loadOrFail(orgId, id);

  const reparenting =
    input.parentId !== undefined &&
    String(input.parentId ?? '') !== String(current.parentId ?? '');

  if (!reparenting) {
    const updated = await Category.findOneAndUpdate(
      { _id: id, orgId },
      { $set: { ...input, updatedBy: actorId } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw ApiError.notFound('Category');

    const names = await nameIndex(orgId, updated.path);
    return toCategoryPayload(updated, breadcrumbOf(updated, names));
  }

  const newParentId = input.parentId ? new Types.ObjectId(input.parentId) : null;

  // A node cannot become its own ancestor. Without this the subtree detaches from the root and
  // becomes a cycle that every traversal loops on forever.
  if (newParentId && newParentId.equals(id)) {
    throw ApiError.validation('Validation failed', [
      { path: 'parentId', message: 'A category cannot be its own parent' },
    ]);
  }

  const { path: newPath } = await resolveParent(orgId, newParentId);
  if (newPath.some((ancestor) => ancestor.equals(id))) {
    throw ApiError.validation('Validation failed', [
      { path: 'parentId', message: 'Cannot move a category into one of its own descendants' },
    ]);
  }

  const descendants = await Category.find({ orgId, path: id }).select('path').lean();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Category.updateOne(
        { _id: id, orgId },
        { $set: { ...input, parentId: newParentId, path: newPath, updatedBy: actorId } },
        { session },
      );

      if (descendants.length > 0) {
        await Category.bulkWrite(
          descendants.map((d) => ({
            updateOne: {
              filter: { _id: d._id },
              // Everything from this node down keeps its shape; only the prefix above it moves.
              // `slice(current.path.length)` is that suffix, starting with this node's own id.
              update: { $set: { path: [...newPath, ...d.path.slice(current.path.length)] } },
            },
          })),
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  return getCategory(orgId, id);
}

/**
 * Deletion is refused while the node has children or products.
 *
 * Cascading would silently take a whole branch of the catalogue — and the products under it —
 * out of every picker, which is not something a delete button should be able to do.
 */
export async function deleteCategory(orgId: Types.ObjectId, id: Types.ObjectId): Promise<void> {
  const doc = await loadOrFail(orgId, id);

  const [childCount, productCount] = await Promise.all([
    Category.countDocuments({ orgId, parentId: id }),
    Product.countDocuments({ orgId, categoryId: id }),
  ]);

  if (childCount > 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${doc.name}" has ${childCount} sub-categor${childCount === 1 ? 'y' : 'ies'}. Move or delete them first.`,
      { childCount },
    );
  }

  if (productCount > 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `${productCount} product(s) are still in "${doc.name}". Deactivate it instead.`,
      { productCount },
    );
  }

  await Category.deleteOne({ _id: id, orgId });
}
