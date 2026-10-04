import { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { locationScopeOf } from '../../middleware/requireLocation.js';
import { invoicePayload } from '../pos/posSale.service.js';

import { Invoice } from './invoice.model.js';

import type { InvoiceDoc } from './invoice.model.js';
import type { ListInvoicesQuery } from './invoice.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { InvoicePayload, PageMeta } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * Invoices, read-only. They are *written* only by the documents that raise them — a counter sale
 * (Day 18) or a posted challan (Day 24) — inside those documents' transactions. Day 25 needs them
 * readable for printing; receipts against them (Day 28) and cancellation come later.
 */

export async function getInvoice(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<InvoicePayload> {
  const doc = await Invoice.findOne({ _id: id, orgId: actor.orgId }).lean();
  const scope = locationScopeOf(actor.user);
  if (!doc || (scope && !scope.includes(String(doc.locationId)))) {
    throw ApiError.notFound('Invoice');
  }
  return invoicePayload(doc);
}

export async function listInvoices(
  actor: RequestActor,
  query: ListInvoicesQuery,
): Promise<{ items: InvoicePayload[]; meta: PageMeta }> {
  const filter: FilterQuery<InvoiceDoc> = { orgId: actor.orgId };
  const scope = locationScopeOf(actor.user);
  if (scope) filter.locationId = { $in: scope.map((id) => new Types.ObjectId(id)) };
  if (query.orderId) filter.orderId = new Types.ObjectId(query.orderId);
  if (query.dispatchId) filter.dispatchId = new Types.ObjectId(query.dispatchId);
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.channel) filter.channel = query.channel;

  const { items, meta } = await paginate<InvoiceDoc>(Invoice, {
    filter,
    query,
    sortable: ['invoiceDate', 'docNo', 'grandTotalMinor', 'dueDate'],
    searchFields: ['docNo'],
    defaultSort: { invoiceDate: -1 },
  });
  return { items: await Promise.all(items.map(invoicePayload)), meta };
}
