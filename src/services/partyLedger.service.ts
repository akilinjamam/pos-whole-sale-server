import { ApiError } from '../lib/ApiError.js';
import { periodKeyOf } from '../lib/period.js';
import { LedgerEntry } from '../modules/ledger/ledgerEntry.model.js';
import { Org } from '../modules/org/org.model.js';
import { Party } from '../modules/party/party.model.js';

import type { LedgerDocType } from '@shared/enums.js';
import type { ClientSession, Types } from 'mongoose';

/**
 * THE party-ledger writer — §8. Like `stock.service`, it is the only code that writes
 * `LedgerEntry`, and it moves the cache (`Party.currentBalanceMinor`) in the **same transaction**,
 * so the balance on a dealer's profile can never disagree with the entries behind it.
 *
 * Takes the caller's session and never commits on its own.
 */

export interface LedgerEntryInput {
  partyId: Types.ObjectId;
  docType: LedgerDocType;
  refType: string;
  refId: Types.ObjectId | null;
  refDocNo: string | null;
  /** Exactly one of debit / credit is non-zero. */
  debitMinor?: number;
  creditMinor?: number;
  narration?: string | null;
  dueDate?: Date | null;
  reversalOfId?: Types.ObjectId | null;
}

export async function postLedgerEntries(
  session: ClientSession,
  {
    orgId,
    entries,
    postedAt,
    actorId,
  }: {
    orgId: Types.ObjectId;
    entries: readonly LedgerEntryInput[];
    postedAt: Date;
    actorId: Types.ObjectId;
  },
): Promise<void> {
  if (entries.length === 0) return;

  for (const [i, e] of entries.entries()) {
    const debit = e.debitMinor ?? 0;
    const credit = e.creditMinor ?? 0;
    if (
      !Number.isInteger(debit) ||
      !Number.isInteger(credit) ||
      debit < 0 ||
      credit < 0 ||
      debit > 0 === credit > 0
    ) {
      throw ApiError.internal(
        `Ledger entry ${i}: exactly one of debit or credit must be a positive whole amount`,
      );
    }
  }

  const org = await Org.findById(orgId).select('timeZone').session(session).lean();
  const periodKey = periodKeyOf(postedAt, org?.timeZone ?? 'Asia/Dhaka');

  await LedgerEntry.insertMany(
    entries.map((e) => ({
      orgId,
      partyId: e.partyId,
      postedAt,
      periodKey,
      docType: e.docType,
      refType: e.refType,
      refId: e.refId,
      refDocNo: e.refDocNo,
      debitMinor: e.debitMinor ?? 0,
      creditMinor: e.creditMinor ?? 0,
      narration: e.narration ?? null,
      dueDate: e.dueDate ?? null,
      reversalOfId: e.reversalOfId ?? null,
      createdBy: actorId,
    })),
    { session, ordered: true },
  );

  // One $inc per party, of the net: debit raises what they owe, credit lowers it.
  const net = new Map<string, { id: Types.ObjectId; delta: number }>();
  for (const e of entries) {
    const k = String(e.partyId);
    const cur = net.get(k) ?? { id: e.partyId, delta: 0 };
    cur.delta += (e.debitMinor ?? 0) - (e.creditMinor ?? 0);
    net.set(k, cur);
  }
  for (const { id, delta } of net.values()) {
    if (delta === 0) continue;
    const { matchedCount } = await Party.updateOne(
      { _id: id, orgId },
      { $inc: { currentBalanceMinor: delta } },
      { session },
    );
    if (matchedCount === 0)
      throw ApiError.internal('Ledger entry for a party that does not exist');
  }
}
