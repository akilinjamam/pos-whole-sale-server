import { Types } from 'mongoose';

import { compareCounts } from '../../domain/reconcile.js';
import { ApiError } from '../../lib/ApiError.js';
import { nextDocNo } from '../../lib/numbering.js';
import { paginate } from '../../lib/paginate.js';
import { dayIn, startOfDayIn } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { openingSide } from '../../shared/ledger.js';
import { Invoice } from '../invoice/invoice.model.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';
import { PaymentDoc } from '../payment/paymentDoc.model.js';

import { LedgerEntry } from './ledgerEntry.model.js';

import type { LedgerEntryDoc } from './ledgerEntry.model.js';
import type { ListLedgerQuery } from './ledger.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { LedgerEntryInput } from '../../services/partyLedger.service.js';
import type { OpeningBalanceImportInput, StatementQuery } from '@shared/ledger.js';
import type {
  LedgerEntryPayload,
  LedgerReconcileResult,
  OpeningBalanceImportResult,
  OpeningBalanceRowResult,
  PageMeta,
  StatementPayload,
} from '@shared/types.js';
import type { FilterQuery } from 'mongoose';

/**
 * The party ledger's own endpoints — §8, Day 27.
 *
 * Every *write* still goes through `services/partyLedger.service.ts`, the only code that inserts a
 * `LedgerEntry` and the only code that moves `Party.currentBalanceMinor`, both in one transaction.
 * This module adds the three things around it: loading opening balances at cutover, reading the
 * ledger, and reconciling the cache against it.
 */

const orgZone = async (orgId: Types.ObjectId) =>
  (await Org.findById(orgId).select('timeZone').lean())?.timeZone ?? 'Asia/Dhaka';

// ─── Opening balances ───────────────────────────────────────────────────────────────────

/**
 * `POST /ledger/opening` — what each dealer and supplier owed at cutover, from the old books.
 *
 * Dry run first: every row is checked and its side (debit / credit) reported, nothing written.
 * Then the same file again with `dryRun: false`, which posts **all or nothing** in one transaction —
 * a half-loaded opening position would be worse than none, because nobody would know which half.
 *
 * Each row becomes one `OPENING` ledger entry through `postLedgerEntries`, so the party's balance
 * moves with it. Refused per row: an unknown code, a code twice in the file, and a party that
 * already has an opening balance — changing one later is an adjustment, with its own audit trail,
 * not a second opening.
 */
export async function importOpeningBalances(
  actor: RequestActor,
  input: OpeningBalanceImportInput,
): Promise<OpeningBalanceImportResult> {
  const zone = await orgZone(actor.orgId);
  const asOf = input.asOf ?? dayIn(new Date(), zone);
  // Midday of the cutover day in the org's zone: unambiguously that day for `periodKey`, for the
  // statement's ordering, and for anything that buckets by day.
  const postedAt = new Date(startOfDayIn(asOf, zone).getTime() + 12 * 3_600_000);

  const codes = [...new Set(input.rows.map((r) => r.code))];
  const parties = await Party.find({ orgId: actor.orgId, code: { $in: codes } })
    .select('code name displayName roles isActive phone tin bin addresses')
    .lean();
  const byCode = new Map(parties.map((p) => [p.code, p]));
  const opened = new Set(
    (
      await LedgerEntry.find({
        orgId: actor.orgId,
        docType: 'OPENING',
        partyId: { $in: parties.map((p) => p._id) },
      })
        .select('partyId')
        .lean()
    ).map((e) => String(e.partyId)),
  );

  const seen = new Map<string, number>();
  const rows: OpeningBalanceRowResult[] = input.rows.map((r) => {
    const errors: string[] = [];
    const party = byCode.get(r.code);
    if (!party) errors.push(`No party with code ${r.code}`);
    const first = seen.get(r.code);
    if (first !== undefined)
      errors.push(`${r.code} is also on line ${first} — one row per party`);
    else seen.set(r.code, r.line);
    if (party && opened.has(String(party._id))) {
      errors.push(`${r.code} already has an opening balance — post an adjustment to change it`);
    }
    if (r.dueDate && r.amountMinor < 0) {
      errors.push('A due date only applies to an amount owed to us (positive)');
    }
    return {
      line: r.line,
      code: r.code,
      status: errors.length ? 'ERROR' : 'POST',
      errors,
      ...(party
        ? {
            partyId: String(party._id),
            partyName: party.displayName ?? party.name,
            roles: party.roles,
          }
        : {}),
      side: r.amountMinor > 0 ? 'DEBIT' : 'CREDIT',
      ...(party ? { creates: openingKind(party.roles, r.amountMinor) } : {}),
      amountMinor: r.amountMinor,
    };
  });

  const good = input.rows.filter((_, i) => rows[i]!.status === 'POST');
  const netMinor = good.reduce((s, r) => s + r.amountMinor, 0);
  // `posted` counts what was actually written — never what would have been: a file refused for
  // one bad row posted nothing, and the report must say so.
  const result = (refId: Types.ObjectId | null, refDocNo: string | null) => ({
    dryRun: input.dryRun,
    asOf,
    rows,
    posted: refId ? good.length : 0,
    failed: rows.length - good.length,
    netMinor,
    refId: refId ? String(refId) : null,
    refDocNo,
  });

  // A file with errors posts nothing — fix it and run it again. Partial cutovers are how the old
  // system's balances ended up not matching anything.
  if (input.dryRun || rows.some((r) => r.status === 'ERROR')) return result(null, null);

  const refId = new Types.ObjectId();
  const refDocNo = `OPEN-BAL-${asOf}`;

  const docNos = await withTransaction(async (session) => {
    // Re-checked inside the transaction, so two people loading the same file at once cannot both
    // succeed. Under snapshot reads neither can see the other's uncommitted entries — what
    // serialises them is that both write the same `Party` documents (the balance `$inc`): the
    // loser gets a WriteConflict, `withTransaction` retries it, and the retry sees the winner's
    // entries here and is refused.
    const already = await LedgerEntry.countDocuments({
      orgId: actor.orgId,
      docType: 'OPENING',
      partyId: { $in: good.map((r) => byCode.get(r.code)!._id) },
    }).session(session);
    if (already > 0) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'Opening balances were loaded for some of these parties meanwhile — run the dry run again',
      );
    }

    // Each row's document, then its one OPENING ledger entry pointing at it. The document does
    // not post to the ledger itself — the opening entry *is* its posting, so nothing is counted
    // twice.
    const entries: LedgerEntryInput[] = [];
    const numbers = new Map<number, string>();
    for (const r of good) {
      const party = byCode.get(r.code)!;
      const narration = r.reference ? `Opening balance — ${r.reference}` : 'Opening balance';
      const kind = openingKind(party.roles, r.amountMinor);
      const base = {
        partyId: party._id,
        docType: 'OPENING' as const,
        ...openingSide(r.amountMinor),
        narration,
      };

      if (kind === 'INVOICE') {
        // An old receivable as an invoice: receipts can pay it off (Day 28) and ageing can age it
        // (Day 30), from the old due date — exactly like any invoice raised after cutover.
        const dueDate = startOfDayIn(r.dueDate ?? asOf, zone);
        const docNo = await nextDocNo(session, actor.orgId, 'OB', postedAt);
        const [inv] = await Invoice.create(
          [
            {
              orgId: actor.orgId,
              docNo,
              series: 'OB',
              channel: 'WHOLESALE',
              partyId: party._id,
              partySnapshot: {
                name: party.displayName ?? party.name,
                phone: party.phone ?? null,
                address: addressLine(party.addresses),
                tin: party.tin ?? null,
                bin: party.bin ?? null,
              },
              locationId: null,
              invoiceDate: postedAt,
              dueDate,
              status: 'POSTED',
              lines: [],
              subtotalMinor: r.amountMinor,
              grandTotalMinor: r.amountMinor,
              paidMinor: 0,
              creditedMinor: 0,
              balanceMinor: r.amountMinor,
              paymentStatus: 'UNPAID',
              note: narration,
              postedAt,
              postedBy: actor.actorId,
              createdBy: actor.actorId,
              updatedBy: actor.actorId,
            },
          ],
          { session },
        );
        entries.push({
          ...base,
          refType: 'INVOICE',
          refId: inv!._id,
          refDocNo: docNo,
          dueDate,
        });
        numbers.set(r.line, docNo);
      } else if (kind === 'ADVANCE') {
        // A dealer's money we held at cutover: an opening receipt, wholly unallocated, so it can
        // be set against their next invoices like any other advance.
        const docNo = await nextDocNo(session, actor.orgId, 'RCPT', postedAt);
        const [pay] = await PaymentDoc.create(
          [
            {
              orgId: actor.orgId,
              docNo,
              series: 'RCPT',
              direction: 'IN',
              partyId: party._id,
              paidAt: postedAt,
              method: 'ADJUSTMENT',
              amountMinor: -r.amountMinor,
              allocatedMinor: 0,
              unallocatedMinor: -r.amountMinor,
              allocations: [],
              reference: r.reference ?? null,
              narration: `Opening advance${r.reference ? ` — ${r.reference}` : ''}`,
              collectedByUserId: actor.actorId,
              createdBy: actor.actorId,
              updatedBy: actor.actorId,
            },
          ],
          { session },
        );
        entries.push({ ...base, refType: 'PAYMENT', refId: pay!._id, refDocNo: docNo });
        numbers.set(r.line, docNo);
      } else {
        // What we owe a supplier: a ledger balance for now. Supplier bills — and the opening ones
        // with them — arrive with purchasing (Day 35).
        entries.push({ ...base, refType: 'OPENING_BALANCE', refId, refDocNo });
      }
    }

    await postLedgerEntries(session, {
      orgId: actor.orgId,
      entries,
      postedAt,
      actorId: actor.actorId,
    });
    // The party's own record of its opening, for display. The balance itself moved above.
    for (const r of good) {
      await Party.updateOne(
        { _id: byCode.get(r.code)!._id, orgId: actor.orgId },
        { $set: { openingBalanceMinor: r.amountMinor, openingBalanceAt: postedAt } },
        { session },
      );
    }
    return numbers;
  });

  for (const row of rows) {
    const docNo = docNos.get(row.line);
    if (docNo) row.docNo = docNo;
  }
  return result(refId, refDocNo);
}

/**
 * What an opening row becomes: owed to us → an opening invoice; owed by us to a supplier → a
 * ledger balance; owed by us to anyone else (a dealer's prepayment) → an opening advance.
 * A party that is both dealer and supplier with a negative balance is taken as a supplier
 * payable — the common case in this trade, and the dry run says so before anything posts.
 */
export function openingKind(
  roles: readonly string[],
  amountMinor: number,
): 'INVOICE' | 'ADVANCE' | 'PAYABLE' {
  if (amountMinor > 0) return 'INVOICE';
  return roles.includes('SUPPLIER') ? 'PAYABLE' : 'ADVANCE';
}

/** A party's default billing address, as one printable line. */
function addressLine(
  addresses: readonly {
    line1: string;
    line2: string | null;
    city: string | null;
    isDefaultBilling: boolean;
  }[],
): string | null {
  const a = addresses.find((x) => x.isDefaultBilling) ?? addresses[0];
  return a ? [a.line1, a.line2, a.city].filter(Boolean).join(', ') : null;
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────

function toPayload(
  e: LedgerEntryDoc,
  party?: { name: string; code: string },
): LedgerEntryPayload {
  return {
    id: String(e._id),
    partyId: String(e.partyId),
    partyName: party?.name,
    partyCode: party?.code,
    postedAt: e.postedAt.toISOString(),
    docType: e.docType,
    refType: e.refType,
    refId: e.refId ? String(e.refId) : null,
    refDocNo: e.refDocNo,
    debitMinor: e.debitMinor,
    creditMinor: e.creditMinor,
    narration: e.narration,
    dueDate: e.dueDate ? e.dueDate.toISOString() : null,
    reversalOfId: e.reversalOfId ? String(e.reversalOfId) : null,
    createdAt: e.createdAt.toISOString(),
  };
}

/** `GET /ledger/entries` — the raw entries, oldest first. The statement view is Day 29. */
export async function listLedgerEntries(
  actor: RequestActor,
  query: ListLedgerQuery,
): Promise<{ items: LedgerEntryPayload[]; meta: PageMeta }> {
  const zone = await orgZone(actor.orgId);
  const filter: FilterQuery<LedgerEntryDoc> = { orgId: actor.orgId };
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  if (query.docType) filter.docType = query.docType;
  if (query.from || query.to) {
    filter.postedAt = {
      ...(query.from ? { $gte: startOfDayIn(query.from, zone) } : {}),
      ...(query.to
        ? { $lt: new Date(startOfDayIn(query.to, zone).getTime() + 86_400_000) }
        : {}),
    };
  }
  const { items, meta } = await paginate<LedgerEntryDoc>(LedgerEntry, {
    filter,
    query,
    sortable: ['postedAt', 'createdAt'],
    searchFields: ['refDocNo', 'narration'],
    defaultSort: { postedAt: 1, _id: 1 },
  });
  const parties = await Party.find({
    orgId: actor.orgId,
    _id: { $in: items.map((e) => e.partyId) },
  })
    .select('name displayName code')
    .lean();
  const partyBy = new Map(
    parties.map((p) => [String(p._id), { name: p.displayName ?? p.name, code: p.code }]),
  );
  return { items: items.map((e) => toPayload(e, partyBy.get(String(e.partyId)))), meta };
}

// ─── Reconcile ──────────────────────────────────────────────────────────────────────────

/**
 * `POST /ledger/reconcile` — `ledger:reconcile` (§8). Re-sum every party's entries and compare
 * with the cached `Party.currentBalanceMinor`. Since both are written in one transaction by one
 * writer, drift should only ever follow a hand edit to the database — and this is how it is found.
 *
 * It **reports** and never repairs: an automatic fix would overwrite the evidence of whatever
 * caused the drift. A party with a balance but no entries is drift; so is one with entries whose
 * balance was zeroed by hand.
 */
export async function reconcileLedger(orgId: Types.ObjectId): Promise<LedgerReconcileResult> {
  const startedAt = Date.now();
  const [sums, parties] = await Promise.all([
    LedgerEntry.aggregate<{ _id: Types.ObjectId; n: number; entries: number }>([
      { $match: { orgId } },
      {
        $group: {
          _id: '$partyId',
          n: { $sum: { $subtract: ['$debitMinor', '$creditMinor'] } },
          entries: { $sum: 1 },
        },
      },
    ]),
    Party.find({ orgId }).select('code name displayName currentBalanceMinor').lean(),
  ]);

  const truth = new Map(sums.map((s) => [String(s._id), s.n]));
  const cache = new Map(parties.map((p) => [String(p._id), p.currentBalanceMinor]));
  const partyBy = new Map(parties.map((p) => [String(p._id), p]));

  const drift = compareCounts(truth, cache).map((d) => {
    const p = partyBy.get(d.key);
    return {
      partyId: d.key,
      // Entries for a party that no longer exists are drift too — and worth a name.
      code: p?.code ?? '?',
      name: p ? (p.displayName ?? p.name) : '(no such party)',
      expected: d.expected,
      actual: d.actual,
      drift: d.drift,
    };
  });

  return {
    checkedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    counts: {
      parties: parties.length,
      partiesWithEntries: sums.length,
      entries: sums.reduce((s, x) => s + x.entries, 0),
    },
    drift,
    clean: drift.length === 0,
  };
}

// ─── Statement (Day 29) ─────────────────────────────────────────────────────────────────

/**
 * `GET /ledger/statement` — a party's account for a period, as their books would show it:
 * balance brought forward, every entry with the balance after it, balance carried forward.
 *
 * The running balance is computed **at read time** by `$setWindowFields` over *all* the party's
 * entries in posting order (`postedAt`, then `_id` for entries at the same instant), and only then
 * narrowed to the period — so a back-dated entry, posted today but dated last week, takes its place
 * in the sequence and every later balance moves with it. A stored running balance could not do
 * that; it would be wrong the moment the back-dated entry was posted (§8).
 */
export async function partyStatement(
  actor: RequestActor,
  query: StatementQuery,
): Promise<StatementPayload> {
  const partyId = new Types.ObjectId(query.partyId);
  const party = await Party.findOne({ _id: partyId, orgId: actor.orgId }).lean();
  if (!party) throw ApiError.notFound('Party');

  const zone = await orgZone(actor.orgId);
  const today = dayIn(new Date(), zone);
  const to = query.to ?? today;
  const from = query.from ?? `${to.slice(0, 8)}01`;
  const start = startOfDayIn(from, zone);
  const end = new Date(startOfDayIn(to, zone).getTime() + 86_400_000);

  const [rows, before] = await Promise.all([
    LedgerEntry.aggregate<LedgerEntryDoc & { runningMinor: number }>([
      { $match: { orgId: actor.orgId, partyId } },
      {
        $setWindowFields: {
          partitionBy: '$partyId',
          sortBy: { postedAt: 1, _id: 1 },
          output: {
            runningMinor: {
              $sum: { $subtract: ['$debitMinor', '$creditMinor'] },
              window: { documents: ['unbounded', 'current'] },
            },
          },
        },
      },
      { $match: { postedAt: { $gte: start, $lt: end } } },
      { $sort: { postedAt: 1, _id: 1 } },
    ]),
    LedgerEntry.aggregate<{ n: number }>([
      { $match: { orgId: actor.orgId, partyId, postedAt: { $lt: start } } },
      { $group: { _id: null, n: { $sum: { $subtract: ['$debitMinor', '$creditMinor'] } } } },
    ]),
  ]);

  const openingBalanceMinor = before[0]?.n ?? 0;
  const debitMinor = rows.reduce((t, r) => t + r.debitMinor, 0);
  const creditMinor = rows.reduce((t, r) => t + r.creditMinor, 0);
  const closingBalanceMinor = openingBalanceMinor + debitMinor - creditMinor;
  // The window and the totals are two independent computations of the same number. If they ever
  // disagree, the statement is wrong — refuse to print it rather than print it wrong.
  const lastRunning = rows.at(-1)?.runningMinor ?? openingBalanceMinor;
  if (lastRunning !== closingBalanceMinor) {
    throw ApiError.internal('The statement does not add up — run ledger reconcile');
  }

  const address = party.addresses.find((a) => a.isDefaultBilling) ?? party.addresses[0];
  return {
    party: {
      id: String(party._id),
      code: party.code,
      name: party.displayName ?? party.name,
      phone: party.phone ?? null,
      address: address
        ? [address.line1, address.line2, address.city].filter(Boolean).join(', ')
        : null,
      creditLimitMinor: party.dealer?.creditLimitMinor ?? null,
      paymentTermsDays: party.dealer?.paymentTermsDays ?? null,
    },
    from,
    to,
    openingBalanceMinor,
    lines: rows.map((r) => ({
      id: String(r._id),
      postedAt: r.postedAt.toISOString(),
      docType: r.docType,
      refType: r.refType,
      refId: r.refId ? String(r.refId) : null,
      refDocNo: r.refDocNo,
      narration: r.narration,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      debitMinor: r.debitMinor,
      creditMinor: r.creditMinor,
      runningMinor: r.runningMinor,
    })),
    totals: { debitMinor, creditMinor },
    closingBalanceMinor,
    currentBalanceMinor: party.currentBalanceMinor,
    generatedAt: new Date().toISOString(),
  };
}
