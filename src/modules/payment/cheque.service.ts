import { Types } from 'mongoose';

import { paymentStatusOf, proposeFifo, validateAllocations } from '../../domain/allocation.js';
import { bounceReverses, canMoveCheque, capToOpen } from '../../domain/cheque.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dayIn, dayToDate } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { Invoice } from '../invoice/invoice.model.js';
import { LedgerEntry } from '../ledger/ledgerEntry.model.js';
import { Org } from '../org/org.model.js';

import { PaymentDoc } from './paymentDoc.model.js';
import {
  allocationDocs,
  asOpen,
  loadParty,
  openInvoiceDocs,
  serialize,
  settle,
} from './receipt.service.js';

import type { ListChequesQuery } from './payment.schema.js';
import type { PaymentDocDoc } from './paymentDoc.model.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { LedgerEntryInput } from '../../services/partyLedger.service.js';
import type { ChequeStatus } from '@shared/enums.js';
import type {
  BounceChequeInput,
  ChequeInput,
  ClearChequeInput,
  DepositChequeInput,
} from '@shared/payments.js';
import type { PageMeta, ReceiptPayload, ReceiptResult } from '@shared/types.js';
import type { ClientSession, FilterQuery } from 'mongoose';

/**
 * Cheques — §8, Day 30. A cheque is a receipt (`RCPT`, method CHEQUE) whose money is not ours
 * until it clears:
 *
 *   take     numbered, PENDING, with the split chosen now kept as `intendedAllocations`.
 *            Nothing posts: no ledger credit, no invoice paid, no advance.
 *   deposit  PENDING → DEPOSITED. Still nothing posts.
 *   clear    → CLEARED, in one transaction: the ledger CREDIT (dated the clearing day) and the
 *            intended split applied, capped at what each invoice still owes; the rest an advance.
 *   bounce   → BOUNCED. After clearing, in one transaction: every allocation undone (each invoice
 *            back to exactly what it owed before — the allocations kept, marked `reversedAt`), a
 *            reversing `CHEQUE_BOUNCE` DEBIT, and optionally the bank's charge as a second DEBIT.
 *            Before clearing there is nothing to undo — only the charge, if any.
 */

const conflict = (message: string) => ApiError.conflict('ILLEGAL_TRANSITION', message);
const refuse = (path: string, message: string) =>
  ApiError.validation('Validation failed', [{ path, message }]);

const orgZone = async (orgId: Types.ObjectId) =>
  (await Org.findById(orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';

async function loadCheque(
  actor: RequestActor,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<PaymentDocDoc & { instrument: NonNullable<PaymentDocDoc['instrument']> }> {
  const p = await PaymentDoc.findOne({ _id: id, orgId: actor.orgId, method: 'CHEQUE' })
    .session(session ?? null)
    .lean();
  if (!p?.instrument) throw ApiError.notFound('Cheque');
  return p as PaymentDocDoc & { instrument: NonNullable<PaymentDocDoc['instrument']> };
}

function assertMove(
  p: { docNo: string; instrument: { status: ChequeStatus } },
  to: ChequeStatus,
) {
  const from = p.instrument.status;
  if (!canMoveCheque(from, to)) {
    throw conflict(`Cheque on ${p.docNo} is ${from} — it cannot become ${to}`);
  }
}

const one = async (actor: RequestActor, doc: PaymentDocDoc) =>
  (await serialize(actor.orgId, [doc]))[0]!;

// ─── Take ───────────────────────────────────────────────────────────────────────────────

export async function receiveCheque(
  actor: RequestActor,
  input: ChequeInput,
): Promise<ReceiptPayload> {
  const party = await loadParty(actor, input.partyId);
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();

  const doc = await withTransaction(async (session) => {
    // The same cheque entered twice is a double count waiting to happen. A bounced one may come
    // back (re-presented), so only a live cheque blocks.
    const dup = await PaymentDoc.findOne({
      orgId: actor.orgId,
      partyId: party._id,
      method: 'CHEQUE',
      'instrument.chequeNo': input.chequeNo,
      'instrument.bankName': input.bankName,
      'instrument.status': { $ne: 'BOUNCED' },
    })
      .select('docNo')
      .session(session)
      .lean();
    if (dup) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        `Cheque ${input.chequeNo} (${input.bankName}) is already on receipt ${dup.docNo}`,
      );
    }

    // The intended split, checked now against the invoices as they are — then kept, not applied.
    const open = (await openInvoiceDocs(actor.orgId, party._id, session)).map(asOpen);
    const plan = input.allocations ?? proposeFifo(open, input.amountMinor).allocations;
    const problems = validateAllocations(open, plan, input.amountMinor);
    if (problems.length) throw ApiError.validation('Validation failed', problems);
    const docNoOf = new Map(open.map((o) => [o.id, o.docNo]));

    const docNo = await nextDocNo(session, actor.orgId, 'RCPT', receivedAt);
    const [created] = await PaymentDoc.create(
      [
        {
          orgId: actor.orgId,
          docNo,
          series: 'RCPT',
          direction: 'IN',
          partyId: party._id,
          paidAt: receivedAt,
          method: 'CHEQUE',
          amountMinor: input.amountMinor,
          // Not ours yet: neither allocated nor an advance until it clears.
          allocatedMinor: 0,
          unallocatedMinor: 0,
          allocations: [],
          intendedAllocations: plan.map((a) => ({
            invoiceId: new Types.ObjectId(a.invoiceId),
            docNo: docNoOf.get(a.invoiceId) ?? '',
            amountMinor: a.amountMinor,
          })),
          instrument: {
            chequeNo: input.chequeNo,
            bankName: input.bankName,
            branch: input.branch ?? null,
            chequeDate: dayToDate(input.chequeDate),
            status: 'PENDING',
          },
          narration: input.narration ?? null,
          collectedByUserId: actor.actorId,
          createdBy: actor.actorId,
          updatedBy: actor.actorId,
        },
      ],
      { session },
    );
    return created!.toObject();
  });
  return one(actor, doc);
}

// ─── Deposit ────────────────────────────────────────────────────────────────────────────

export async function depositCheque(
  actor: RequestActor,
  id: Types.ObjectId,
  input: DepositChequeInput,
): Promise<ReceiptPayload> {
  const p = await loadCheque(actor, id);
  assertMove(p, 'DEPOSITED');
  const updated = await PaymentDoc.findOneAndUpdate(
    { _id: p._id, orgId: actor.orgId, 'instrument.status': 'PENDING' },
    {
      $set: {
        'instrument.status': 'DEPOSITED',
        'instrument.depositedAt': input.depositedAt ? new Date(input.depositedAt) : new Date(),
        ...(input.note
          ? { narration: [p.narration, input.note].filter(Boolean).join(' · ') }
          : {}),
        updatedBy: actor.actorId,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw conflict('The cheque changed meanwhile — reload');
  return one(actor, updated);
}

// ─── Clear ──────────────────────────────────────────────────────────────────────────────

export async function clearCheque(
  actor: RequestActor,
  id: Types.ObjectId,
  input: ClearChequeInput,
): Promise<ReceiptResult> {
  const clearedAt = input.clearedAt ? new Date(input.clearedAt) : new Date();
  const zone = await orgZone(actor.orgId);

  const result = await withTransaction(async (session) => {
    const p = await loadCheque(actor, id, session);
    assertMove(p, 'CLEARED');
    const dated = p.instrument.chequeDate;
    if (dated && dayIn(clearedAt, zone) < dated.toISOString().slice(0, 10)) {
      throw refuse(
        'clearedAt',
        `This cheque is dated ${dated.toISOString().slice(0, 10)} — it cannot clear before then`,
      );
    }

    // The split chosen when it was taken, applied to the invoices as they are *now*.
    const open = (await openInvoiceDocs(actor.orgId, p.partyId!, session)).map(asOpen);
    const applied = capToOpen(
      p.intendedAllocations.map((a) => ({
        invoiceId: String(a.invoiceId),
        amountMinor: a.amountMinor,
      })),
      new Map(open.map((o) => [o.id, o.balanceMinor])),
    );
    const invoices = await settle(session, actor.orgId, applied);
    const allocated = applied.reduce((t, a) => t + a.amountMinor, 0);

    const updated = await PaymentDoc.findOneAndUpdate(
      { _id: p._id, orgId: actor.orgId, 'instrument.status': p.instrument.status },
      {
        $set: {
          'instrument.status': 'CLEARED',
          'instrument.clearedAt': clearedAt,
          allocations: allocationDocs(
            applied,
            new Map(open.map((o) => [o.id, o.docNo])),
            clearedAt,
            actor.actorId,
          ),
          allocatedMinor: allocated,
          unallocatedMinor: p.amountMinor - allocated,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) throw conflict('The cheque changed meanwhile — reload');

    // Only now is it money: the ledger credit, dated the day it cleared.
    await postLedgerEntries(session, {
      orgId: actor.orgId,
      postedAt: clearedAt,
      actorId: actor.actorId,
      entries: [
        {
          partyId: p.partyId!,
          docType: 'RECEIPT',
          refType: 'PAYMENT',
          refId: p._id,
          refDocNo: p.docNo,
          creditMinor: p.amountMinor,
          narration: `Cheque ${p.instrument.chequeNo} (${p.instrument.bankName}) cleared — receipt ${p.docNo}${
            invoices.length
              ? ` against ${invoices.map((i) => i.docNo).join(', ')}`
              : ' — on account'
          }`,
        },
      ],
    });
    return { doc: updated, invoices };
  });
  return { receipt: await one(actor, result.doc), invoices: result.invoices };
}

// ─── Bounce ─────────────────────────────────────────────────────────────────────────────

export async function bounceCheque(
  actor: RequestActor,
  id: Types.ObjectId,
  input: BounceChequeInput,
): Promise<ReceiptResult> {
  const bouncedAt = input.bouncedAt ? new Date(input.bouncedAt) : new Date();
  const charge = input.bounceChargeMinor ?? 0;

  const result = await withTransaction(async (session) => {
    const p = await loadCheque(actor, id, session);
    assertMove(p, 'BOUNCED');
    const reverses = bounceReverses(p.instrument.status);
    const touched: ReceiptResult['invoices'] = [];

    if (reverses) {
      // Undo every allocation still standing — including any spent from this cheque's advance
      // later. Each invoice goes back to exactly what it owed before this cheque paid it.
      for (const a of p.allocations.filter((x) => !x.reversedAt)) {
        const inv = await Invoice.findOneAndUpdate(
          { _id: a.invoiceId, orgId: actor.orgId, paidMinor: { $gte: a.amountMinor } },
          { $inc: { paidMinor: -a.amountMinor, balanceMinor: a.amountMinor } },
          { new: true, session },
        ).lean();
        if (!inv)
          throw ApiError.internal(`Invoice ${a.docNo} does not hold this cheque's payment`);
        const paymentStatus = paymentStatusOf(
          inv.grandTotalMinor,
          inv.paidMinor,
          inv.creditedMinor ?? 0,
        );
        if (paymentStatus !== inv.paymentStatus) {
          await Invoice.updateOne({ _id: inv._id }, { $set: { paymentStatus } }, { session });
        }
        touched.push({
          id: String(inv._id),
          docNo: inv.docNo ?? '',
          balanceMinor: inv.balanceMinor,
          paymentStatus,
        });
      }
    }

    const updated = await PaymentDoc.findOneAndUpdate(
      { _id: p._id, orgId: actor.orgId, 'instrument.status': p.instrument.status },
      {
        $set: {
          'instrument.status': 'BOUNCED',
          'instrument.bouncedAt': bouncedAt,
          'instrument.bounceReason': input.reason,
          'instrument.bounceChargeMinor': charge,
          'allocations.$[live].reversedAt': bouncedAt,
          allocatedMinor: 0,
          unallocatedMinor: 0,
          updatedBy: actor.actorId,
        },
      },
      { new: true, session, arrayFilters: [{ 'live.reversedAt': null }] },
    ).lean();
    if (!updated) throw conflict('The cheque changed meanwhile — reload');

    const entries: LedgerEntryInput[] = [];
    if (reverses) {
      const credit = await LedgerEntry.findOne({
        orgId: actor.orgId,
        refType: 'PAYMENT',
        refId: p._id,
        docType: 'RECEIPT',
      })
        .select('_id')
        .session(session)
        .lean();
      entries.push({
        partyId: p.partyId!,
        docType: 'CHEQUE_BOUNCE',
        refType: 'PAYMENT',
        refId: p._id,
        refDocNo: p.docNo,
        debitMinor: p.amountMinor,
        reversalOfId: credit?._id ?? null,
        narration: `Cheque ${p.instrument.chequeNo} (${p.instrument.bankName}) bounced — ${input.reason}`,
      });
    }
    if (charge > 0) {
      entries.push({
        partyId: p.partyId!,
        docType: 'CHEQUE_BOUNCE',
        refType: 'PAYMENT',
        refId: p._id,
        refDocNo: p.docNo,
        debitMinor: charge,
        narration: `Bank charge for bounced cheque ${p.instrument.chequeNo}`,
      });
    }
    if (entries.length) {
      await postLedgerEntries(session, {
        orgId: actor.orgId,
        postedAt: bouncedAt,
        actorId: actor.actorId,
        entries,
      });
    }
    return { doc: updated, invoices: touched };
  });
  return { receipt: await one(actor, result.doc), invoices: result.invoices };
}

// ─── Register ───────────────────────────────────────────────────────────────────────────

/** The cheque register: by status, oldest cheque date first — what to deposit next. */
export async function listCheques(
  actor: RequestActor,
  query: ListChequesQuery,
): Promise<{ items: ReceiptPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PaymentDocDoc> = {
    orgId: actor.orgId,
    method: 'CHEQUE',
    direction: 'IN',
  };
  if (query.status) filter['instrument.status'] = query.status;
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.dueBy) filter['instrument.chequeDate'] = { $lte: dayToDate(query.dueBy) };
  const { items, meta } = await paginate<PaymentDocDoc>(PaymentDoc, {
    filter,
    query,
    sortable: ['instrument.chequeDate', 'paidAt', 'amountMinor', 'docNo'],
    searchFields: ['docNo', 'instrument.chequeNo', 'instrument.bankName'],
    defaultSort: { 'instrument.chequeDate': 1, paidAt: 1 },
  });
  return { items: await serialize(actor.orgId, items), meta };
}
