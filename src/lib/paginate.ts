import { z } from 'zod';

import type { PageMeta, Paginated } from '@shared/types.js';
import type { FilterQuery, Model, PipelineStage } from 'mongoose';

/**
 * One list implementation for every module.
 *
 * It keeps the useful shape of the retail system's `filtering.js` — `$match` plus a `$facet`
 * that returns the page and its count in a single round trip — and fixes its three problems:
 *
 *  1. **Search uses a text index**, not an unanchored `$regex` per field. A regex without a
 *     leading anchor cannot use an index, so every search there is a collection scan that gets
 *     slower each month the catalog grows.
 *  2. **Filters and sorts are per-module whitelists.** Copying arbitrary query keys into the
 *     `$match` lets a caller filter on `passwordHash` or sort by an unindexed field and stall
 *     the server.
 *  3. **`limit` is capped** at 200, so `?limit=100000` cannot pull the whole collection into
 *     memory.
 */

export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/** The query-string contract every list endpoint shares. Compose with per-module filters. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  /** Free-text search, run against the collection's text index when it has one. */
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.string().trim().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface PaginateOptions<T> {
  /**
   * Always includes `orgId`; built by the service from the verified token, never the body.
   *
   * **Ids must already be `ObjectId`s.** This runs an aggregation pipeline, and `$match` —
   * unlike `find` — does not cast against the schema. A string id silently matches nothing, so
   * the symptom is an empty list rather than an error, which is the worst way to find out.
   */
  filter: FilterQuery<T>;
  query: ListQuery;
  /** Sortable field names. Anything outside this list falls back to `defaultSort`. */
  sortable: readonly string[];
  defaultSort?: Record<string, 1 | -1>;
  /** Fields to project away, e.g. cost columns when the caller lacks `stock:viewCost`. */
  exclude?: readonly string[];
}

function buildSort(query: ListQuery, sortable: readonly string[], fallback: Record<string, 1 | -1>) {
  if (!query.sort || !sortable.includes(query.sort)) return fallback;
  return { [query.sort]: query.order === 'desc' ? -1 : 1 } as Record<string, 1 | -1>;
}

function buildMeta(page: number, limit: number, total: number): PageMeta {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

/**
 * Run a whitelisted, paginated list query.
 *
 * When `q` is present the filter gains a `$text` clause, so the collection must carry a text
 * index — every master in this system (product, party, location, user) declares one.
 */
export async function paginate<T>(
  model: Model<T>,
  options: PaginateOptions<T>,
): Promise<Paginated<T>> {
  const { filter, query, sortable, defaultSort = { createdAt: -1 }, exclude = [] } = options;

  const match: FilterQuery<T> = query.q
    ? { ...filter, $text: { $search: query.q } }
    : { ...filter };

  const sort = buildSort(query, sortable, defaultSort);
  const skip = (query.page - 1) * query.limit;

  const projection = Object.fromEntries(exclude.map((f) => [f, 0]));

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      // One round trip for the page and the count. Two queries would race: a document inserted
      // between them shows up in the total but not the page, and the UI reports a phantom row.
      $facet: {
        items: [
          { $sort: sort },
          { $skip: skip },
          { $limit: query.limit },
          ...(exclude.length > 0 ? [{ $project: projection }] : []),
        ],
        total: [{ $count: 'value' }],
      },
    },
  ];

  const [result] = await model.aggregate<{
    items: T[];
    total: { value: number }[];
  }>(pipeline);

  const items = result?.items ?? [];
  const total = result?.total[0]?.value ?? 0;

  return { items, meta: buildMeta(query.page, query.limit, total) };
}
