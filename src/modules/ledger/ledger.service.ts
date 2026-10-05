import { Types } from 'mongoose';

import { compareCounts } from '../../domain/reconcile.js';
import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { dayIn, startOfDayIn } from '../../lib/period.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { postLedgerEntries } from '../../services/partyLedger.service.js';
import { openingSide } from '../../shared/ledger.js';
import { Org } from '../org/org.model.js';
import { Party } from '../party/party.model.js';

import { LedgerEntry } from './ledgerEntry.model.js';

import type { LedgerEntryDoc } from './ledgerEntry.model.js';
import type { ListLedgerQuery } from './ledger.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { LedgerEntryInput } from '../../services/partyLedger.service.js';
import type { OpeningBalanceImportInput } from '@shared/ledger.js';
import type {
  LedgerEntryPayload,
  LedgerReconcileResult,
  OpeningBalanceImportResult,
  OpeningBalanceRowResult,
  PageMeta,
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
    .select('code name displayName roles isActive')
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
  const entries: LedgerEntryInput[] = good.map((r) => {
    const party = byCode.get(r.code)!;
    return {
      partyId: party._id,
      docType: 'OPENING',
      refType: 'OPENING_BALANCE',
      refId,
      refDocNo,
      ...openingSide(r.amountMinor),
      narration: r.reference ? `Opening balance — ${r.reference}` : 'Opening balance',
      dueDate: r.amountMinor > 0 ? startOfDayIn(r.dueDate ?? asOf, zone) : null,
    };
  });

  await withTransaction(async (session) => {
    // Re-checked inside the transaction, so two people loading the same file at once cannot both
    // succeed. Under snapshot reads neither can see the other's uncommitted entries — what
    // serialises them is that both write the same `Party` documents (the balance `$inc`): the
    // loser gets a WriteConflict, `withTransaction` retries it, and the retry sees the winner's
    // entries here and is refused.
    const already = await LedgerEntry.countDocuments({
      orgId: actor.orgId,
      docType: 'OPENING',
      partyId: { $in: entries.map((e) => e.partyId) },
    }).session(session);
    if (already > 0) {
      throw ApiError.conflict(
        'DUPLICATE_DOCUMENT',
        'Opening balances were loaded for some of these parties meanwhile — run the dry run again',
      );
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
  });
  return result(refId, refDocNo);
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
