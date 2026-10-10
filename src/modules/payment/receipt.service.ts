import { Types } from 'mongoose';

import {
  fifoOrder,
  paymentStatusOf,
  proposeFifo,
  validateAllocations,
} from '../../domain/allocation.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Party } from '../party/party.model.js';

import { PaymentDoc } from './paymentDoc.model.js';

import type { ListReceiptsQuery } from './payment.schema.js';
import type { AllocationDoc, PaymentDocDoc } from './paymentDoc.model.js';
import type { Allocation, OpenInvoice } from '../../domain/allocation.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { InvoiceDoc } from '../invoice/invoice.model.js';
import type {
  AllocateReceiptInput,
  AllocationPreviewQuery,
  ReceiptInput,
} from '@shared/payments.js';
import type {
  AllocationPreview,
  OpenInvoicePayload,
  PageMeta,
  ReceiptPayload,
  ReceiptResult,
} from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Receipts — §8 "Payment allocation", Day 28.
 *
 * Posting a receipt, in one transaction:
 *   1. allocate an `RCPT` number;
 *   2. validate the allocation — explicit, or oldest-due-first — against the party's open invoices
 *      as they are *now*;
 *   3. per invoice: `$inc paidMinor`, `$inc balanceMinor` by the negative, guarded so an invoice
 *      can never be paid past zero, and recompute `paymentStatus`;
 *   4. create the receipt with `unallocatedMinor = amount − Σ allocations` — an advance;
 *   5. post ONE credit to the party's ledger for the full amount, through the only writer.
 *
 * The ledger sees the whole receipt at once, allocated or not: what the dealer owes falls by what
 * they paid. Allocation only decides *which invoices* it settles — which is what ageing and the
 * statement's per-invoice view are built on.
 */

const refuse = (problems: { path: string; message: string }[]) =>
  ApiError.validation('Validation failed', problems);

// ─── Open invoices ──────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

export async function openInvoiceDocs(
  orgId: Types.ObjectId,
  partyId: Types.ObjectId,
  session?: ClientSession,
): Promise<InvoiceDoc[]> {
  return Invoice.find({ orgId, partyId, status: 'POSTED', balanceMinor: { $gt: 0 } })
    .session(session ?? null)
    .lean();
}

export const asOpen = (i: InvoiceDoc): OpenInvoice => ({
  id: String(i._id),
  docNo: i.docNo ?? '',
  invoiceDate: i.invoiceDate,
  dueDate: i.dueDate,
  balanceMinor: i.balanceMinor,
});

function openPayload(i: InvoiceDoc, now: Date): OpenInvoicePayload {
  return {
    id: String(i._id),
    docNo: i.docNo ?? '',
    channel: i.channel,
    invoiceDate: i.invoiceDate.toISOString(),
    dueDate: i.dueDate ? i.dueDate.toISOString() : null,
    grandTotalMinor: i.grandTotalMinor,
    paidMinor: i.paidMinor,
    creditedMinor: i.creditedMinor ?? 0,
    balanceMinor: i.balanceMinor,
    daysOverdue: i.dueDate ? Math.floor((now.getTime() - i.dueDate.getTime()) / DAY) : null,
  };
}

export async function loadParty(actor: RequestActor, partyId: string) {
  const party = await Party.findOne({ _id: partyId, orgId: actor.orgId })
    .select('name displayName code roles')
    .lean();
  if (!party || !party.roles.some((r) => r === 'DEALER' || r === 'CUSTOMER')) {
    throw refuse([{ path: 'partyId', message: 'No such dealer or customer' }]);
  }
  return party;
}

/**
 * Settle these allocations against the invoices, inside the caller's transaction. Each `$inc` is
 * guarded by `balanceMinor >= amount`: a receipt racing another for the same invoice cannot pay it
 * past zero — the loser finds nothing to match and the whole posting is refused.
 */
export async function settle(
  session: ClientSession,
  orgId: Types.ObjectId,
  plan: readonly Allocation[],
): Promise<ReceiptResult['invoices']> {
  const out: ReceiptResult['invoices'] = [];
  for (const a of plan) {
    const inv = await Invoice.findOneAndUpdate(
      {
        _id: new Types.ObjectId(a.invoiceId),
        orgId,
        status: 'POSTED',
        balanceMinor: { $gte: a.amountMinor },
      },
      { $inc: { paidMinor: a.amountMinor, balanceMinor: -a.amountMinor } },
      { new: true, session },
    ).lean();
    if (!inv) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'An invoice was paid by another receipt meanwhile — reload the allocation and try again',
        { invoiceId: a.invoiceId },
      );
    }
    const paymentStatus = paymentStatusOf(
      inv.grandTotalMinor,
      inv.paidMinor,
      inv.creditedMinor ?? 0,
    );
    if (paymentStatus !== inv.paymentStatus) {
      await Invoice.updateOne({ _id: inv._id }, { $set: { paymentStatus } }, { session });
    }
    out.push({
      id: String(inv._id),
      docNo: inv.docNo ?? '',
      balanceMinor: inv.balanceMinor,
      paymentStatus,
    });
  }
  return out;
}

// ─── Wire shape ─────────────────────────────────────────────────────────────────────────

function toPayload(p: PaymentDocDoc, party?: { name: string; code: string }): ReceiptPayload {
  return {
    id: String(p._id),
    docNo: p.docNo,
    partyId: String(p.partyId),
    partyName: party?.name,
    partyCode: party?.code,
    paidAt: p.paidAt.toISOString(),
    method: p.method,
    amountMinor: p.amountMinor,
    allocatedMinor: p.allocatedMinor,
    unallocatedMinor: p.unallocatedMinor,
    allocations: p.allocations.map((a) => ({
      invoiceId: String(a.invoiceId),
      docNo: a.docNo,
      amountMinor: a.amountMinor,
      allocatedAt: a.allocatedAt.toISOString(),
      reversedAt: a.reversedAt ? a.reversedAt.toISOString() : null,
    })),
    reference: p.reference ?? null,
    mfs: p.mfs
      ? {
          provider: p.mfs.provider,
          trxId: p.mfs.trxId,
          senderNumber: p.mfs.senderNumber ?? null,
        }
      : null,
    narration: p.narration,
    status: p.status,
    instrument: p.instrument
      ? {
          chequeNo: p.instrument.chequeNo,
          bankName: p.instrument.bankName ?? null,
          branch: p.instrument.branch ?? null,
          chequeDate: p.instrument.chequeDate ? p.instrument.chequeDate.toISOString() : null,
          status: p.instrument.status,
          depositedAt: p.instrument.depositedAt ? p.instrument.depositedAt.toISOString() : null,
          clearedAt: p.instrument.clearedAt ? p.instrument.clearedAt.toISOString() : null,
          bouncedAt: p.instrument.bouncedAt ? p.instrument.bouncedAt.toISOString() : null,
          bounceReason: p.instrument.bounceReason ?? null,
          bounceChargeMinor: p.instrument.bounceChargeMinor ?? 0,
        }
      : null,
    intendedAllocations: (p.intendedAllocations ?? []).map((a) => ({
      invoiceId: String(a.invoiceId),
      docNo: a.docNo,
      amountMinor: a.amountMinor,
    })),
    collectedByUserId: p.collectedByUserId ? String(p.collectedByUserId) : null,
    createdAt: p.createdAt.toISOString(),
  };
}

export async function serialize(
  orgId: Types.ObjectId,
  docs: PaymentDocDoc[],
): Promise<ReceiptPayload[]> {
  const parties = await Party.find({ orgId, _id: { $in: docs.map((d) => d.partyId) } })
    .select('name displayName code')
    .lean();
  const by = new Map(
    parties.map((p) => [String(p._id), { name: p.displayName ?? p.name, code: p.code }]),
  );
  return docs.map((d) => toPayload(d, by.get(String(d.partyId))));
}

export const allocationDocs = (
  plan: readonly Allocation[],
  docNoOf: Map<string, string>,
  at: Date,
  by: Types.ObjectId,
): Omit<AllocationDoc, '_id'>[] =>
  plan.map((a) => ({
    kind: 'INVOICE' as const,
    invoiceId: new Types.ObjectId(a.invoiceId),
    docNo: docNoOf.get(a.invoiceId) ?? '',
    amountMinor: a.amountMinor,
    allocatedAt: at,
    allocatedBy: by,
    reversedAt: null,
  }));

// ─── Preview ────────────────────────────────────────────────────────────────────────────

/** `GET /payments/allocation-preview` — what oldest-due-first would do with this much money. */
export async function allocationPreview(
  actor: RequestActor,
  query: AllocationPreviewQuery,
): Promise<AllocationPreview> {
  await loadParty(actor, query.partyId);
  const partyId = new Types.ObjectId(query.partyId);
  const [docs, advance] = await Promise.all([
    openInvoiceDocs(actor.orgId, partyId),
    PaymentDoc.aggregate<{ n: number }>([
      {
        $match: {
          orgId: actor.orgId,
          partyId,
          direction: 'IN',
          status: 'POSTED',
          unallocatedMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, n: { $sum: '$unallocatedMinor' } } },
    ]),
  ]);
  const open = docs.map(asOpen);
  const plan = proposeFifo(open, query.amountMinor);
  const docNoOf = new Map(open.map((o) => [o.id, o.docNo]));
  const now = new Date();
  return {
    partyId: query.partyId,
    amountMinor: query.amountMinor,
    // In the order allocation uses, so the proposal reads top to bottom.
    openInvoices: [...docs]
      .sort((a, b) => fifoOrder(asOpen(a), asOpen(b)))
      .map((d) => openPayload(d, now)),
    totalOpenMinor: open.reduce((s, o) => s + o.balanceMinor, 0),
    allocations: plan.allocations.map((a) => ({ ...a, docNo: docNoOf.get(a.invoiceId) ?? '' })),
    allocatedMinor: plan.allocatedMinor,
    unallocatedMinor: plan.unallocatedMinor,
    existingAdvanceMinor: advance[0]?.n ?? 0,
  };
}

// ─── Post ───────────────────────────────────────────────────────────────────────────────

export async function postReceipt(
  actor: RequestActor,
  input: ReceiptInput,
): Promise<ReceiptResult> {
  const party = await loadParty(actor, input.partyId);
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();

  const result = await withTransaction(async (session) => {
    // A mobile-money transaction id is spent once. Say which receipt already has it — the unique
    // index stays as the backstop for two entries racing.
    if (input.mfs) {
      const dup = await PaymentDoc.findOne({
        orgId: actor.orgId,
        'mfs.provider': input.mfs.provider,
        'mfs.trxId': input.mfs.trxId,
      })
        .select('docNo')
        .session(session)
        .lean();
      if (dup) {
        throw ApiError.conflict(
          'DUPLICATE_DOCUMENT',
          `${input.mfs.provider} transaction ${input.mfs.trxId} is already on receipt ${dup.docNo}`,
          { receiptId: String(dup._id), docNo: dup.docNo },
        );
      }
    }
    // The open invoices as of this transaction — not as of whatever the preview showed.
    const docs = await openInvoiceDocs(actor.orgId, party._id, session);
    const open = docs.map(asOpen);
    const plan =
      input.allocations === undefined
        ? proposeFifo(open, input.amountMinor).allocations
        : input.allocations;
    const problems = validateAllocations(open, plan, input.amountMinor);
    if (problems.length) throw refuse(problems);

    const docNo = await nextDocNo(session, actor.orgId, 'RCPT', paidAt);
    const id = new Types.ObjectId();
    const allocatedMinor = plan.reduce((s, a) => s + a.amountMinor, 0);
    const invoices = await settle(session, actor.orgId, plan);

    const [doc] = await PaymentDoc.create(
      [
        {
          _id: id,
          orgId: actor.orgId,
          docNo,
          series: 'RCPT',
          direction: 'IN',
          partyId: party._id,
          paidAt,
          method: input.method,
          amountMinor: input.amountMinor,
          allocatedMinor,
          unallocatedMinor: input.amountMinor - allocatedMinor,
          // Stamped with when the money arrived, not when it was typed in: a receipt back-dated
          // to 10 Sep paid the invoice on 10 Sep, and ageing as of any later day must say so.
          allocations: allocationDocs(
            plan,
            new Map(open.map((o) => [o.id, o.docNo])),
            paidAt,
            actor.actorId,
          ),
          mfs: input.mfs ?? null,
          reference: input.reference ?? null,
          narration: input.narration ?? null,
          collectedByUserId: actor.actorId,
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );

    await postLedgerEntries(session, {
      orgId: actor.orgId,
      postedAt: paidAt,
      actorId: actor.actorId,
      entries: [
        {
          partyId: party._id,
          docType: 'RECEIPT',
          refType: 'PAYMENT',
          refId: id,
          refDocNo: docNo,
          creditMinor: input.amountMinor,
          narration: `Receipt ${docNo} (${input.method.toLowerCase()})${
            invoices.length
              ? ` against ${invoices.map((i) => i.docNo).join(', ')}`
              : ' — on account'
          }`,
        },
      ],
    });
    return { doc: doc!.toObject(), invoices };
  });

  const [receipt] = await serialize(actor.orgId, [result.doc]);
  return { receipt: receipt!, invoices: result.invoices };
}

// ─── Allocate later ─────────────────────────────────────────────────────────────────────

/**
 * `POST /payments/receipts/:id/allocate` — set (part of) an advance against invoices. The money
 * was credited to the ledger when it was received, so nothing posts to the ledger now: only
 * *which invoices* it settles changes.
 */
export async function allocateReceipt(
  actor: RequestActor,
  id: Types.ObjectId,
  input: AllocateReceiptInput,
): Promise<ReceiptResult> {
  const result = await withTransaction(async (session) => {
    const p = await PaymentDoc.findOne({ _id: id, orgId: actor.orgId }).session(session).lean();
    if (!p || p.direction !== 'IN') throw ApiError.notFound('Receipt');
    if (p.status !== 'POSTED' || p.unallocatedMinor <= 0) {
      throw ApiError.conflict('ILLEGAL_TRANSITION', `${p.docNo} has nothing left to allocate`);
    }

    const docs = await openInvoiceDocs(actor.orgId, p.partyId!, session);
    const open = docs.map(asOpen);
    const plan = input.allocations ?? proposeFifo(open, p.unallocatedMinor).allocations;
    if (plan.length === 0) {
      throw ApiError.conflict(
        'ILLEGAL_TRANSITION',
        'The party has no open invoices to allocate to',
      );
    }
    const problems = validateAllocations(open, plan, p.unallocatedMinor);
    if (problems.length) throw refuse(problems);

    const sum = plan.reduce((s, a) => s + a.amountMinor, 0);
    const invoices = await settle(session, actor.orgId, plan);
    // Guarded like the invoices: two people spending the same advance cannot both succeed.
    const updated = await PaymentDoc.findOneAndUpdate(
      { _id: p._id, orgId: actor.orgId, unallocatedMinor: { $gte: sum } },
      {
        $inc: { allocatedMinor: sum, unallocatedMinor: -sum },
        $push: {
          allocations: {
            $each: allocationDocs(
              plan,
              new Map(open.map((o) => [o.id, o.docNo])),
              new Date(),
              actor.actorId,
            ),
          },
        },
        $set: { updatedBy: actor.actorId },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'This advance was allocated meanwhile — reload',
      );
    }
    return { doc: updated, invoices };
  });

  const [receipt] = await serialize(actor.orgId, [result.doc]);
  return { receipt: receipt!, invoices: result.invoices };
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

export async function listReceipts(
  actor: RequestActor,
  query: ListReceiptsQuery,
): Promise<{ items: ReceiptPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PaymentDocDoc> = { orgId: actor.orgId, direction: 'IN' };
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.unallocated) filter.unallocatedMinor = { $gt: 0 };
  if (query.method) filter.method = query.method;
  const { items, meta } = await paginate<PaymentDocDoc>(PaymentDoc, {
    filter,
    query,
    sortable: ['paidAt', 'docNo', 'amountMinor', 'unallocatedMinor'],
    searchFields: ['docNo', 'reference', 'narration'],
    defaultSort: { paidAt: -1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}

export async function getReceipt(
  actor: RequestActor,
  id: Types.ObjectId,
): Promise<ReceiptPayload> {
  const doc = await PaymentDoc.findOne({ _id: id, orgId: actor.orgId, direction: 'IN' }).lean();
  if (!doc) throw ApiError.notFound('Receipt');
  const [payload] = await serialize(actor.orgId, [doc]);
  return payload!;
}
